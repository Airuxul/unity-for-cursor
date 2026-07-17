import * as vscode from 'vscode';
import {
	attachToUnityEditor,
	UnityAttachDebugConfigurationProvider,
	UNITY_FOR_CURSOR_DEBUG_TYPE,
} from './attach/attach';
import { registerAutoReattach } from './attach/reattach';
import { registerEditorLog } from './log/editorLog';
import { registerBreakpointFilter } from './breakpoints/breakpointFilter';

const RESHARPER_EXTENSION_ID = 'JetBrains.resharper-code';

// package.json's `extensionDependencies` already asks the Marketplace to auto-install this
// when the gallery resolves it, but that mechanism is silent and version/gallery-dependent.
// This runtime check is the visible fallback: it fires whenever this extension activates
// without ReSharper present, and offers a one-click install via the same command the
// Extensions view uses.
async function ensureResharperInstalled(): Promise<void> {
	if (vscode.extensions.getExtension(RESHARPER_EXTENSION_ID)) {
		return;
	}

	const install = '现在安装';
	const choice = await vscode.window.showWarningMessage(
		`Unity for Cursor 依赖 "C# by ReSharper" (${RESHARPER_EXTENSION_ID}) 提供调试能力，但未检测到该扩展。`,
		install
	);
	if (choice !== install) {
		return;
	}

	await vscode.commands.executeCommand('workbench.extensions.installExtension', RESHARPER_EXTENSION_ID);
	vscode.window.showInformationMessage('"C# by ReSharper" 安装完成后，请重新加载窗口 (Reload Window)。');
}

export function activate(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('cursorUnityAttach.attachToEditor', attachToUnityEditor),
		vscode.debug.registerDebugConfigurationProvider(
			UNITY_FOR_CURSOR_DEBUG_TYPE,
			new UnityAttachDebugConfigurationProvider()
		)
	);
	registerAutoReattach(context);
	registerEditorLog(context);
	registerBreakpointFilter(context);
	void ensureResharperInstalled();
}

export function deactivate(): void {}
