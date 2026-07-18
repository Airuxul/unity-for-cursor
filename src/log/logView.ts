import * as vscode from 'vscode';
import { EditorLogTailer, MAX_ENTRIES } from './logTailer';

function getNonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let text = '';
	for (let i = 0; i < 32; i++) {
		text += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return text;
}

export const EDITOR_LOG_VIEW_ID = 'unityForCursor.editorLogView';

export class LogViewProvider implements vscode.WebviewViewProvider {
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly context: vscode.ExtensionContext, private readonly tailer: EditorLogTailer) {}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
		};
		webviewView.webview.html = this.getHtml(webviewView.webview);

		const viewDisposables: vscode.Disposable[] = [];
		viewDisposables.push(
			webviewView.webview.onDidReceiveMessage((message: { type: string; file?: string; line?: number }) => {
				if (message.type === 'openLocation' && message.file && message.line !== undefined) {
					void vscode.commands.executeCommand('unityForCursor.openLogLocation', message.file, message.line);
				} else if (message.type === 'clear') {
					this.tailer.clearBuffer();
				} else if (message.type === 'ready') {
					void webviewView.webview.postMessage({
						type: 'init',
						maxEntries: MAX_ENTRIES,
						entries: this.tailer.getSnapshot(),
					});
				}
			})
		);
		viewDisposables.push(
			this.tailer.onEntries((entries) => void webviewView.webview.postMessage({ type: 'append', entries }))
		);
		viewDisposables.push(
			this.tailer.onUpdateEntry((update) => void webviewView.webview.postMessage({ type: 'updateEntry', ...update }))
		);
		webviewView.onDidDispose(() => viewDisposables.forEach((d) => d.dispose()));
		this.disposables.push(...viewDisposables);
	}

	reveal(): void {
		void vscode.commands.executeCommand(`${EDITOR_LOG_VIEW_ID}.focus`);
	}

	dispose(): void {
		this.disposables.forEach((d) => d.dispose());
	}

	private getHtml(webview: vscode.Webview): string {
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.js'));
		const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.css'));
		const nonce = getNonce();

		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
	<link rel="stylesheet" href="${styleUri}">
	<title>Unity Editor Log</title>
</head>
<body>
	<div id="toolbar">
		<button id="clear-btn" title="Clear log">Clear</button>
		<button id="filter-error" class="filter-toggle level-error active" data-level="error">Errors <span class="count">0</span></button>
		<button id="filter-warning" class="filter-toggle level-warning active" data-level="warning">Warnings <span class="count">0</span></button>
		<button id="filter-info" class="filter-toggle level-info active" data-level="info">Info <span class="count">0</span></button>
		<button id="autoscroll-btn" class="active" title="Pause/resume auto-scroll">▶ Auto-scroll</button>
		<input id="search-input" type="text" placeholder="Search log…">
	</div>
	<div id="split">
		<div id="master-list">
			<div id="master-sizer"></div>
			<div id="master-viewport"></div>
		</div>
		<div id="detail-pane">
			<div id="detail-empty">No log entry selected</div>
			<div id="detail-content" hidden>
				<div id="detail-header">
					<span id="detail-icon" class="entry-icon"></span>
					<span id="detail-time" class="entry-time"></span>
				</div>
				<div id="detail-text"></div>
			</div>
		</div>
	</div>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}
}
