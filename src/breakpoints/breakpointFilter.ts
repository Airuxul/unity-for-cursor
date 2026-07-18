import * as vscode from 'vscode';

// Supports `*`, `**`, `?`, and `{a,b,c}` brace expansion — the subset covering the overwhelming
// majority of real-world exclude patterns (including VS Code's own `files.exclude` conventions).
// Does NOT support character classes (`[abc]`) or negation (`!pattern`) — unlike a full glob
// library, an unsupported pattern here fails silently (matches nothing) rather than erroring,
// which is exactly the risk of exposing this as a user-configurable setting without documenting
// the restriction (see `ignoreBreakpointsGlobs` in package.json).
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
		} else if (c === '{') {
			const close = glob.indexOf('}', i);
			if (close === -1) {
				pattern += '\\{';
				continue;
			}
			const alternatives = glob
				.slice(i + 1, close)
				.split(',')
				.map((alt) => globToRegExp(alt).source.slice(1, -1));
			pattern += '(?:' + alternatives.join('|') + ')';
			i = close;
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

function locationKey(bp: vscode.SourceBreakpoint): string {
	return `${bp.location.uri.toString()}:${bp.location.range.start.line}`;
}

export function registerBreakpointFilter(context: vscode.ExtensionContext): void {
	// Track breakpoints we've auto-disabled, persisted across reloads, keyed by file+line rather
	// than `Breakpoint.id` — the id is an opaque per-session GUID with no documented guarantee of
	// staying the same across a window reload, which would make a persisted id-based set silently
	// stop matching anything. If the user manually re-enables a tracked breakpoint, we must never
	// disable it again — even though every window reload re-scans `vscode.debug.breakpoints` from
	// scratch (existing breakpoints don't replay through `onDidChangeBreakpoints`'s `added` list,
	// so that initial scan is the only way to catch newly-ignorable breakpoints from a previous
	// session).
	const AUTO_DISABLED_KEY = 'unityForCursor.autoDisabledBreakpointKeys';
	const getAutoDisabledKeys = (): Set<string> =>
		new Set(context.workspaceState.get<string[]>(AUTO_DISABLED_KEY, []));
	const setAutoDisabledKeys = (keys: Set<string>) =>
		context.workspaceState.update(AUTO_DISABLED_KEY, Array.from(keys));

	const disableIfIgnored = (candidates: readonly vscode.Breakpoint[]) => {
		const globs = getIgnoreGlobs();
		if (globs.length === 0) {
			return;
		}
		const autoDisabledKeys = getAutoDisabledKeys();
		const originals: vscode.SourceBreakpoint[] = [];
		const replacements: vscode.SourceBreakpoint[] = [];
		for (const bp of candidates) {
			if (!(bp instanceof vscode.SourceBreakpoint) || !bp.enabled) {
				continue;
			}
			if (autoDisabledKeys.has(locationKey(bp))) {
				// We disabled this one before and it's back to enabled now — the user re-enabled
				// it on purpose. Leave this specific breakpoint alone permanently.
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
		for (const bp of replacements) {
			autoDisabledKeys.add(locationKey(bp));
		}
		void setAutoDisabledKeys(autoDisabledKeys);
		vscode.window.setStatusBarMessage(
			`$(circle-slash) Unity for Cursor: 已自动禁用 ${originals.length} 个忽略列表中的断点`,
			4000
		);
	};

	context.subscriptions.push(vscode.debug.onDidChangeBreakpoints((e) => disableIfIgnored(e.added)));
	disableIfIgnored(vscode.debug.breakpoints);
}
