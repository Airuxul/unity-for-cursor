import * as vscode from 'vscode';
import { EditorLogTailer, LogEntry, MAX_ENTRIES } from './logTailer';

function getNonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let text = '';
	for (let i = 0; i < 32; i++) {
		text += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return text;
}

export class LogPanel {
	private static current: LogPanel | undefined;

	private readonly panel: vscode.WebviewPanel;
	private readonly disposables: vscode.Disposable[] = [];

	static createOrShow(context: vscode.ExtensionContext, tailer: EditorLogTailer): void {
		if (LogPanel.current) {
			LogPanel.current.panel.reveal(LogPanel.current.panel.viewColumn, true);
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			'unityEditorLog',
			'Unity Editor Log',
			{ viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
			}
		);

		LogPanel.current = new LogPanel(panel, context, tailer);
	}

	private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext, tailer: EditorLogTailer) {
		this.panel = panel;
		this.panel.webview.html = this.getHtml(context.extensionUri);

		this.disposables.push(
			this.panel.webview.onDidReceiveMessage((message: { type: string; file?: string; line?: number }) => {
				if (message.type === 'openLocation' && message.file && message.line !== undefined) {
					void vscode.commands.executeCommand('unityForCursor.openLogLocation', message.file, message.line);
				} else if (message.type === 'clear') {
					tailer.clearBuffer();
				} else if (message.type === 'ready') {
					this.postMessage({ type: 'init', maxEntries: MAX_ENTRIES, entries: tailer.getSnapshot() });
				}
			})
		);

		this.disposables.push(
			tailer.onEntries((entries) => this.postMessage({ type: 'append', entries }))
		);
		this.disposables.push(
			tailer.onUpdateEntry((update) => this.postMessage({ type: 'updateEntry', ...update }))
		);

		this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
	}

	private postMessage(message: { type: string; entries?: LogEntry[]; maxEntries?: number; id?: number; appendText?: string }): void {
		void this.panel.webview.postMessage(message);
	}

	private dispose(): void {
		LogPanel.current = undefined;
		for (const d of this.disposables) {
			d.dispose();
		}
	}

	private getHtml(extensionUri: vscode.Uri): string {
		const webview = this.panel.webview;
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'main.js'));
		const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'main.css'));
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
		<button id="clear-btn" title="清空日志">清空</button>
		<button id="filter-error" class="filter-toggle active" data-level="error">Errors <span class="count">0</span></button>
		<button id="filter-warning" class="filter-toggle active" data-level="warning">Warnings <span class="count">0</span></button>
		<button id="filter-info" class="filter-toggle active" data-level="info">Info <span class="count">0</span></button>
		<button id="autoscroll-btn" class="active" title="暂停/恢复自动滚动">▶ 自动滚动</button>
	</div>
	<div id="entries"></div>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}
}
