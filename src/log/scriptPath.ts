import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

function isUnityProjectRoot(dir: string): boolean {
	return fs.existsSync(path.join(dir, 'ProjectSettings', 'ProjectVersion.txt'));
}

// The workspace folder is usually the Unity project itself, but a repo root with the Unity project
// one level down (e.g. Client/) is also common. Cached per workspace path; only falls back to the
// workspace root when no Unity project is found.
const projectRootCache = new Map<string, string>();

function getUnityProjectRoot(workspacePath: string): string {
	const cached = projectRootCache.get(workspacePath);
	if (cached) {
		return cached;
	}
	let root = workspacePath;
	if (!isUnityProjectRoot(workspacePath)) {
		try {
			const child = fs
				.readdirSync(workspacePath, { withFileTypes: true })
				.find((entry) => entry.isDirectory() && isUnityProjectRoot(path.join(workspacePath, entry.name)));
			if (child) {
				root = path.join(workspacePath, child.name);
			}
		} catch {
			// Unreadable workspace folder — keep the workspace root.
		}
	}
	projectRootCache.set(workspacePath, root);
	return root;
}

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
	return vscode.Uri.file(path.join(getUnityProjectRoot(folder.uri.fsPath), file));
}
