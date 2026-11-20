// A single thing we can attach ReSharper's `mono` debugger to. `editor` is a local Unity Editor
// process (discovered in `unityProcess.ts`); `player` is a standalone Player or device discovered
// via UDP multicast (`discoverPlayers.ts`).
export type AttachTarget =
	| { kind: 'editor'; pid: number; port: number; projectPath: string }
	| { kind: 'player'; label: string; address: string; port: number };

export function attachTargetLabel(target: AttachTarget): string {
	return target.kind === 'editor' ? `Editor (PID ${target.pid})` : `Player ${target.label}`;
}

export function attachSessionName(target: AttachTarget): string {
	return `Unity for Cursor: ${attachTargetLabel(target)}`;
}
