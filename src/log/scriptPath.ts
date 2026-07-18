import * as vscode from 'vscode';
import * as path from 'path';

// Unity's stack-frame/compiler-diagnostic paths are project-root-relative (e.g. "Assets/Foo.cs"),
// but an absolute path is also possible in some log contexts — handle both.
export function resolveScriptUri(file: string): vscode.Uri | undefined {
	if (path.isAbsolute(file)) {
		return vscode.Uri.file(file);
	}
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		return undefined;
	}
	return vscode.Uri.file(path.join(folder.uri.fsPath, file));
}
