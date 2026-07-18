import * as vscode from 'vscode';
import { EditorLogTailer } from './logTailer';

// Strings observed in a real Editor.log around a script-compile/Domain Reload cycle. Unity's
// internal logging phrasing isn't a documented/stable API and can differ across Editor versions —
// these are simply what a live Editor.log on this machine actually printed, not a spec.
const COMPILE_START_PATTERN = /Begin MonoManager ReloadAssembly/;
const COMPILE_END_PATTERN = /Domain Reload Profiling:|Loaded All Assemblies/;

// If the start marker fires but the version-specific end marker text doesn't match (a real risk
// given the above), a "compiling" indicator would otherwise get stuck forever. This is a safety
// net, not a real compile-time estimate.
const STUCK_TIMEOUT_MS = 120_000;

export interface CompileEventWatcher extends vscode.Disposable {
	onCompileStart: vscode.Event<void>;
	onCompileEnd: vscode.Event<void>;
}

export function watchCompileEvents(tailer: EditorLogTailer): CompileEventWatcher {
	const startEmitter = new vscode.EventEmitter<void>();
	const endEmitter = new vscode.EventEmitter<void>();
	let compiling = false;
	let stuckTimer: ReturnType<typeof setTimeout> | undefined;

	function clearStuckTimer(): void {
		if (stuckTimer !== undefined) {
			clearTimeout(stuckTimer);
			stuckTimer = undefined;
		}
	}

	function end(): void {
		if (!compiling) {
			return;
		}
		compiling = false;
		clearStuckTimer();
		endEmitter.fire();
	}

	const sub = tailer.onEntries((entries) => {
		for (const entry of entries) {
			if (!compiling && COMPILE_START_PATTERN.test(entry.text)) {
				compiling = true;
				clearStuckTimer();
				stuckTimer = setTimeout(end, STUCK_TIMEOUT_MS);
				startEmitter.fire();
			} else if (compiling && COMPILE_END_PATTERN.test(entry.text)) {
				end();
			}
		}
	});

	return {
		onCompileStart: startEmitter.event,
		onCompileEnd: endEmitter.event,
		dispose(): void {
			sub.dispose();
			clearStuckTimer();
			startEmitter.dispose();
			endEmitter.dispose();
		},
	};
}
