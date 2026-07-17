import * as vscode from 'vscode';

function globToRegExp(glob: string): RegExp {
	let pattern = '';
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === '*' && glob[i + 1] === '*') {
			pattern += '.*';
			i++;
		} else if (c === '*') {
			pattern += '[^/]*';
		} else if (c === '?') {
			pattern += '[^/]';
		} else if ('.+^${}()|[]\\'.includes(c)) {
			pattern += '\\' + c;
		} else {
			pattern += c;
		}
	}
	return new RegExp('^' + pattern + '$', 'i');
}

function matchesAnyGlob(filePath: string, globs: string[]): boolean {
	const normalized = filePath.replace(/\\/g, '/');
	return globs.some((glob) => globToRegExp(glob).test(normalized));
}

function getIgnoreGlobs(): string[] {
	return vscode.workspace.getConfiguration('unityForCursor').get<string[]>('ignoreBreakpointsGlobs', []);
}

export function registerBreakpointFilter(context: vscode.ExtensionContext): void {
	// Only auto-disable breakpoints at the moment they're *added* — if the user manually
	// re-enables one afterward (a `changed` event, not `added`), we leave it alone. Otherwise
	// this would fight the user every time they deliberately step into ignored code.
	const disableIfIgnored = (added: readonly vscode.Breakpoint[]) => {
		const globs = getIgnoreGlobs();
		if (globs.length === 0) {
			return;
		}
		const originals: vscode.SourceBreakpoint[] = [];
		const replacements: vscode.SourceBreakpoint[] = [];
		for (const bp of added) {
			if (!(bp instanceof vscode.SourceBreakpoint) || !bp.enabled) {
				continue;
			}
			if (matchesAnyGlob(bp.location.uri.fsPath, globs)) {
				originals.push(bp);
				replacements.push(
					new vscode.SourceBreakpoint(bp.location, false, bp.condition, bp.hitCondition, bp.logMessage)
				);
			}
		}
		if (originals.length === 0) {
			return;
		}
		vscode.debug.removeBreakpoints(originals);
		vscode.debug.addBreakpoints(replacements);
		vscode.window.setStatusBarMessage(
			`$(circle-slash) Unity for Cursor: 已自动禁用 ${originals.length} 个忽略列表中的断点`,
			4000
		);
	};

	context.subscriptions.push(vscode.debug.onDidChangeBreakpoints((e) => disableIfIgnored(e.added)));
	disableIfIgnored(vscode.debug.breakpoints);
}
