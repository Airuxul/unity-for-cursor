import * as vscode from 'vscode';
import { EditorLogTailer } from './logTailer';
import { EDITOR_LOG_VIEW_ID, LogViewProvider } from './logView';
import { resolveScriptUri } from './scriptPath';

export function registerEditorLog(context: vscode.ExtensionContext): EditorLogTailer {
	const tailer = new EditorLogTailer();
	context.subscriptions.push(tailer);

	const provider = new LogViewProvider(context, tailer);
	context.subscriptions.push(provider);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(EDITOR_LOG_VIEW_ID, provider, {
			webviewOptions: { retainContextWhenHidden: true },
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('unityForCursor.showEditorLog', () => provider.reveal())
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

	return tailer;
}
