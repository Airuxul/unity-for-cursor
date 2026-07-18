import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import chokidar, { FSWatcher } from 'chokidar';

const LOG_LANGUAGE_ID = 'log';
// Unity runtime stack-trace frames look like: "MyScript.Update () (at Assets/Scripts/MyScript.cs:42)".
const STACK_FRAME_PATTERN = /\(at ([^()\r\n]+):(\d+)\)/g;
// Unity compiler diagnostics look like: "Assets/Scripts/MyScript.cs(42,10): error CS0246: ...".
const COMPILER_DIAGNOSTIC_PATTERN = /([^\s():]+\.cs)\((\d+),(\d+)\):\s*(?:error|warning)\s+CS\d+/g;

const ERROR_BLOCK_PATTERN = /error CS\d+|UnityEngine\.Debug:LogError|UnityEngine\.Debug:LogException|\bException\b.*?:/;
const WARNING_BLOCK_PATTERN = /warning CS\d+|UnityEngine\.Debug:LogWarning/;

function getEditorLogPath(): string {
	return path.join(os.homedir(), 'AppData', 'Local', 'Unity', 'Editor', 'Editor.log');
}

function resolveScriptUri(file: string): vscode.Uri | undefined {
	if (path.isAbsolute(file)) {
		return vscode.Uri.file(file);
	}
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		return undefined;
	}
	return vscode.Uri.file(path.join(folder.uri.fsPath, file));
}

function classifyBlock(block: string): 'error' | 'warning' | 'info' {
	if (ERROR_BLOCK_PATTERN.test(block)) {
		return 'error';
	}
	if (WARNING_BLOCK_PATTERN.test(block)) {
		return 'warning';
	}
	return 'info';
}

interface LinkCache {
	scannedLength: number;
	links: vscode.DocumentLink[];
}

const linkCaches = new WeakMap<vscode.TextDocument, LinkCache>();

interface RawLink {
	start: number;
	end: number;
	target: vscode.Uri;
}

function scanLinks(text: string, offset: number): RawLink[] {
	const links: RawLink[] = [];

	STACK_FRAME_PATTERN.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = STACK_FRAME_PATTERN.exec(text))) {
		const [full, file, lineStr] = match;
		const args = encodeURIComponent(JSON.stringify([file, parseInt(lineStr, 10)]));
		links.push({
			start: offset + match.index,
			end: offset + match.index + full.length,
			target: vscode.Uri.parse(`command:unityForCursor.openLogLocation?${args}`),
		});
	}

	COMPILER_DIAGNOSTIC_PATTERN.lastIndex = 0;
	while ((match = COMPILER_DIAGNOSTIC_PATTERN.exec(text))) {
		const [full, file, lineStr] = match;
		const args = encodeURIComponent(JSON.stringify([file, parseInt(lineStr, 10)]));
		links.push({
			start: offset + match.index,
			end: offset + match.index + full.length,
			target: vscode.Uri.parse(`command:unityForCursor.openLogLocation?${args}`),
		});
	}

	return links;
}

class UnityLogLinkProvider implements vscode.DocumentLinkProvider {
	provideDocumentLinks(document: vscode.TextDocument): vscode.DocumentLink[] {
		const currentLength = document.getText().length;
		let cache = linkCaches.get(document);

		if (!cache || currentLength < cache.scannedLength) {
			// Document was cleared or replaced (new Editor session) — rescan from scratch.
			cache = { scannedLength: 0, links: [] };
		}

		if (currentLength > cache.scannedLength) {
			const newText = document.getText().slice(cache.scannedLength);
			const rawLinks = scanLinks(newText, cache.scannedLength);
			const resolvedLinks = rawLinks.map(
				(raw) =>
					new vscode.DocumentLink(
						new vscode.Range(document.positionAt(raw.start), document.positionAt(raw.end)),
						raw.target
					)
			);
			cache = { scannedLength: currentLength, links: [...cache.links, ...resolvedLinks] };
			linkCaches.set(document, cache);
		}

		return cache.links;
	}
}

export function registerEditorLog(context: vscode.ExtensionContext): void {
	const channel = vscode.window.createOutputChannel('Unity Editor Log', { log: true });
	context.subscriptions.push(channel);

	context.subscriptions.push(
		vscode.languages.registerDocumentLinkProvider({ language: LOG_LANGUAGE_ID }, new UnityLogLinkProvider())
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('unityForCursor.showEditorLog', () => channel.show(true))
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('unityForCursor.openLogLocation', async (file: string, line: number) => {
			const uri = resolveScriptUri(file);
			if (!uri) {
				vscode.window.showErrorMessage('Unity for Cursor: 请先打开工作区，才能跳转到脚本文件。');
				return;
			}
			try {
				const doc = await vscode.workspace.openTextDocument(uri);
				const position = new vscode.Position(Math.max(0, line - 1), 0);
				await vscode.window.showTextDocument(doc, { selection: new vscode.Range(position, position) });
			} catch {
				vscode.window.showErrorMessage(`Unity for Cursor: 未找到脚本文件 ${file}`);
			}
		})
	);

	let offset = 0;
	let pending = false;
	// Unity's log blocks are separated by blank lines; a chunk boundary can split the last
	// block in two, so we hold it back until the next pump instead of misclassifying it.
	let carry = '';

	// LogOutputChannel colors and timestamps only the first line passed to error()/warn()/info() —
	// the rest of a multi-line block (e.g. a stack trace) renders as plain text if passed in the
	// same call. So we log just the header line through the leveled call for the color/tag, then
	// append the remaining lines as plain continuation text, followed by a blank separator line
	// so consecutive entries don't visually run together.
	function logBlock(block: string): void {
		if (!block.trim()) {
			return;
		}
		const level = classifyBlock(block);
		const lines = block.split(/\r?\n/);
		const header = lines[0];
		const rest = lines.slice(1).join('\n');
		if (level === 'error') {
			channel.error(header);
		} else if (level === 'warning') {
			channel.warn(header);
		} else {
			channel.info(header);
		}
		if (rest.trim()) {
			channel.appendLine(rest);
		}
		channel.appendLine('');
	}

	function emit(text: string): void {
		const combined = carry + text;
		const blocks = combined.split(/\r?\n\r?\n+/);
		carry = blocks.pop() ?? '';
		for (const block of blocks) {
			logBlock(block);
		}
	}

	function flushCarry(): void {
		logBlock(carry);
		carry = '';
	}

	function pump(): void {
		if (pending) {
			return;
		}
		pending = true;
		const logPath = getEditorLogPath();
		fs.stat(logPath, (statErr, stats) => {
			if (statErr) {
				pending = false;
				return;
			}
			if (stats.size < offset) {
				// Unity truncated/replaced the log (new Editor session started).
				flushCarry();
				offset = 0;
			}
			if (stats.size === offset) {
				pending = false;
				return;
			}
			const start = offset;
			offset = stats.size;
			const stream = fs.createReadStream(logPath, { start, end: stats.size - 1, encoding: 'utf8' });
			let chunk = '';
			stream.on('data', (data) => (chunk += data));
			stream.on('close', () => {
				if (chunk) {
					emit(chunk);
				}
				pending = false;
			});
			stream.on('error', () => {
				pending = false;
			});
		});
	}

	let watcher: FSWatcher | undefined;
	try {
		watcher = chokidar.watch(getEditorLogPath(), {
			awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
			ignoreInitial: true,
		});
		watcher.on('add', pump).on('change', pump).on('unlink', () => (offset = 0));
	} catch {
		// Unity has never run on this machine — the log directory doesn't exist yet.
	}
	pump();

	context.subscriptions.push({
		dispose: () => {
			void watcher?.close();
		},
	});
}
