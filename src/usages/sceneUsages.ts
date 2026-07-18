import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';

const GUID_PATTERN = /^guid:\s*([0-9a-f]{32})/m;
// Cap on simultaneous open file handles while scanning a large project's scenes/prefabs — a plain
// Promise.all over every candidate could momentarily open thousands of file descriptors at once.
const SCAN_CONCURRENCY = 32;
// Hover fires on every mouse-rest, so results are cached per guid rather than rescanned each time.
// Invalidated wholesale (not per-file) on any .unity/.prefab change — imprecise, but scene/prefab
// edits are rare compared to hovers, so precision isn't worth the extra bookkeeping.
const usageCache = new Map<string, UsageMatch[]>();
const inFlightScans = new Map<string, Promise<UsageMatch[]>>();

async function readGuidFromMeta(scriptUri: vscode.Uri): Promise<string | undefined> {
	const metaUri = vscode.Uri.file(scriptUri.fsPath + '.meta');
	let content: string;
	try {
		content = await fs.readFile(metaUri.fsPath, 'utf8');
	} catch {
		return undefined;
	}
	return content.match(GUID_PATTERN)?.[1];
}

interface UsageMatch {
	uri: vscode.Uri;
	line: number;
}

async function findGuidUsages(guid: string, progress: vscode.Progress<{ message?: string }>): Promise<UsageMatch[]> {
	// `exclude` is passed as `null` (not the `**/{Library,Temp}/**` string this used to be) because
	// vscode.workspace.findFiles applies the user's `files.exclude` setting on top of *any* string
	// exclude pattern, and Unity+VS Code setups very commonly hide **/*.prefab, **/*.unity and
	// **/*.meta there to declutter the Explorer — which would silently make every candidate
	// disappear before the scan even starts. `null` is the only value that bypasses files.exclude.
	const candidates = (await vscode.workspace.findFiles('**/*.{unity,prefab}', null)).filter(
		(uri) => !/[/\\](Library|Temp)[/\\]/.test(uri.fsPath)
	);
	const matches: UsageMatch[] = [];

	for (let i = 0; i < candidates.length; i += SCAN_CONCURRENCY) {
		const batch = candidates.slice(i, i + SCAN_CONCURRENCY);
		progress.report({ message: `扫描中 (${i}/${candidates.length})...` });
		await Promise.all(
			batch.map(async (uri) => {
				let text: string;
				try {
					text = await fs.readFile(uri.fsPath, 'utf8');
				} catch {
					return;
				}
				if (!text.includes(guid)) {
					return;
				}
				const lines = text.split(/\r?\n/);
				const line = lines.findIndex((l) => l.includes(guid));
				matches.push({ uri, line: Math.max(0, line) });
			})
		);
	}

	return matches;
}

async function getGuidUsagesCached(
	guid: string,
	progress?: vscode.Progress<{ message?: string }>
): Promise<UsageMatch[]> {
	const cached = usageCache.get(guid);
	if (cached) {
		return cached;
	}
	let inFlight = inFlightScans.get(guid);
	if (!inFlight) {
		inFlight = findGuidUsages(guid, progress ?? { report: () => undefined }).finally(() => {
			inFlightScans.delete(guid);
		});
		inFlightScans.set(guid, inFlight);
	}
	const matches = await inFlight;
	usageCache.set(guid, matches);
	return matches;
}

const NOT_FOUND_MESSAGE =
	'Unity for Cursor: 未在任何场景/预制体中找到对该脚本的引用（只能找到直接挂载在 GameObject 上、' +
	'序列化了 GUID 引用的脚本；若该脚本是通过 AddComponent<T>() 之类的方式在运行时动态挂载的，' +
	'资源文件里不会有 GUID 引用，因此找不到）。';

export function registerSceneUsages(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand(
			'unityForCursor.jumpToUsage',
			async (uriString: string, line: number) => {
				const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uriString));
				const position = new vscode.Position(line, 0);
				await vscode.window.showTextDocument(doc, { selection: new vscode.Range(position, position) });
			}
		)
	);

	const watcher = vscode.workspace.createFileSystemWatcher('**/*.{unity,prefab}');
	context.subscriptions.push(watcher);
	context.subscriptions.push(watcher.onDidChange(() => usageCache.clear()));
	context.subscriptions.push(watcher.onDidCreate(() => usageCache.clear()));
	context.subscriptions.push(watcher.onDidDelete(() => usageCache.clear()));

	context.subscriptions.push(
		vscode.commands.registerCommand('unityForCursor.findSceneUsages', async (arg?: vscode.Uri | string) => {
			// The hover button invokes this via a markdown `command:` URI, which round-trips its
			// JSON-encoded argument as a plain string rather than a real vscode.Uri — unlike the
			// right-click menu, which passes an actual Uri.
			const scriptUri = (typeof arg === 'string' ? vscode.Uri.parse(arg) : arg) ?? vscode.window.activeTextEditor?.document.uri;
			if (!scriptUri || !scriptUri.fsPath.endsWith('.cs')) {
				vscode.window.showErrorMessage('Unity for Cursor: 请先打开或选中一个 .cs 脚本文件。');
				return;
			}

			const guid = await readGuidFromMeta(scriptUri);
			if (!guid) {
				vscode.window.showErrorMessage('Unity for Cursor: 未找到该脚本的 .meta 文件（可能尚未被 Unity 导入）。');
				return;
			}

			const matches = await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: 'Unity for Cursor: 正在查找场景/预制体引用...',
					cancellable: false,
				},
				(progress) => getGuidUsagesCached(guid, progress)
			);

			if (matches.length === 0) {
				vscode.window.showInformationMessage(NOT_FOUND_MESSAGE);
				return;
			}

			const picked = await vscode.window.showQuickPick(
				matches.map((m) => ({
					label: vscode.workspace.asRelativePath(m.uri),
					description: `line ${m.line + 1}`,
					match: m,
				})),
				{ placeHolder: `找到 ${matches.length} 处引用` }
			);
			if (!picked) {
				return;
			}

			await vscode.commands.executeCommand(
				'unityForCursor.jumpToUsage',
				picked.match.uri.toString(),
				picked.match.line
			);
		})
	);
}

// Matches "class Foo" / "class Foo : Bar" declaration lines — used to find the class name being
// hovered, not arbitrary identifiers.
const CLASS_DECLARATION_PATTERN = /\bclass\s+(\w+)/;

// Unity requires a MonoBehaviour's class name to match its file name, so the file's own guid can
// only ever "belong" to the class declared on that line — this also keeps the (cache-backed but
// still not free) scan from firing on every random word hover.
function isFileNameClassDeclaration(document: vscode.TextDocument, line: number, word: string): boolean {
	const match = document.lineAt(line).text.match(CLASS_DECLARATION_PATTERN);
	if (!match || match[1] !== word) {
		return false;
	}
	return path.basename(document.fileName, '.cs') === word;
}

export function registerSceneUsagesHover(context: vscode.ExtensionContext): void {
	if (!vscode.workspace.getConfiguration('unityForCursor').get<boolean>('enableSceneUsagesHover', true)) {
		return;
	}

	context.subscriptions.push(
		vscode.languages.registerHoverProvider(
			{ language: 'csharp' },
			{
				async provideHover(document, position, token) {
					const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_]\w*/);
					if (!wordRange) {
						return undefined;
					}
					const word = document.getText(wordRange);
					if (!isFileNameClassDeclaration(document, position.line, word)) {
						return undefined;
					}

					const guid = await readGuidFromMeta(document.uri);
					if (!guid || token.isCancellationRequested) {
						return undefined;
					}

					const args = encodeURIComponent(JSON.stringify([document.uri.toString()]));
					const markdown = new vscode.MarkdownString(undefined, true);
					markdown.isTrusted = true;
					markdown.appendMarkdown(
						`[$(search) Find Usages in Scenes/Prefabs](command:unityForCursor.findSceneUsages?${args})`
					);

					return new vscode.Hover(markdown, wordRange);
				},
			}
		)
	);
}
