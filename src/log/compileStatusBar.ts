import * as vscode from 'vscode';
import { EditorLogTailer } from './logTailer';
import { watchCompileEvents } from './compileEvents';

export function registerCompileStatusBar(context: vscode.ExtensionContext, tailer: EditorLogTailer): void {
	if (!vscode.workspace.getConfiguration('unityForCursor').get<boolean>('enableCompileStatusBar', true)) {
		return;
	}

	const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	item.text = '$(sync~spin) Unity 编译中...';
	context.subscriptions.push(item);

	const watcher = watchCompileEvents(tailer);
	context.subscriptions.push(watcher);
	context.subscriptions.push(watcher.onCompileStart(() => item.show()));
	context.subscriptions.push(watcher.onCompileEnd(() => item.hide()));
}
