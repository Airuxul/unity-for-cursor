import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const LOG_LANGUAGE_ID = 'unity-editor-log';
// Unity stack-trace frames look like: "MyScript.Update () (at Assets/Scripts/MyScript.cs:42)".
const STACK_FRAME_PATTERN = /\(at ([^()\r\n]+):(\d+)\)/g;

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

class UnityLogLinkProvider implements vscode.DocumentLinkProvider {
	provideDocumentLinks(document: vscode.TextDocument): vscode.DocumentLink[] {
		const text = document.getText();
		const links: vscode.DocumentLink[] = [];
		STACK_FRAME_PATTERN.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = STACK_FRAME_PATTERN.exec(text))) {
			const [full, file, lineStr] = match;
			const start = document.positionAt(match.index);
			const end = document.positionAt(match.index + full.length);
			const args = encodeURIComponent(JSON.stringify([file, parseInt(lineStr, 10)]));
			links.push(
				new vscode.DocumentLink(
					new vscode.Range(start, end),
					vscode.Uri.parse(`command:unityForCursor.openLogLocation?${args}`)
				)
			);
		}
		return links;
	}
}

export function registerEditorLog(context: vscode.ExtensionContext): void {
	const channel = vscode.window.createOutputChannel('Unity Editor Log', LOG_LANGUAGE_ID);
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
	let watcher: fs.FSWatcher | undefined;
	let pending = false;

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
					channel.append(chunk);
				}
				pending = false;
			});
			stream.on('error', () => {
				pending = false;
			});
		});
	}

	try {
		watcher = fs.watch(path.dirname(getEditorLogPath()), (_event, filename) => {
			if (!filename || filename === path.basename(getEditorLogPath())) {
				pump();
			}
		});
	} catch {
		// Unity has never run on this machine — the log directory doesn't exist yet.
	}
	pump();

	context.subscriptions.push({ dispose: () => watcher?.close() });
}
