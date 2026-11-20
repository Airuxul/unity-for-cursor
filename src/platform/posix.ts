import * as fs from 'fs';
import { runCommand } from './exec';
import { PlatformAdapter, ProcessInfo } from './types';

// macOS and Linux share the same tooling (ps + lsof); only the Unity executable name and the
// Editor.log location differ, so both are built from this one factory.
export interface PosixPlatformOptions {
	name: string;
	// Matches the Unity Editor executable at the start of a `ps` command line.
	//   macOS: /Applications/Unity/Hub/Editor/<ver>/Unity.app/Contents/MacOS/Unity
	//   Linux: ~/Unity/Hub/Editor/<ver>/Editor/Unity
	unityExecutable: RegExp;
	editorLogPath: () => string;
}

// GUI apps on macOS (Cursor launched from the Dock) don't inherit a login-shell PATH, and lsof
// lives in /usr/sbin there — so resolve it by absolute path when possible.
const LSOF = ['/usr/sbin/lsof', '/usr/bin/lsof'].find((p) => fs.existsSync(p)) ?? 'lsof';

// `ps -ww` disables column truncation so long -projectPath values survive intact.
async function listProcesses(): Promise<ProcessInfo[]> {
	const raw = await runCommand('ps', ['-axww', '-o', 'pid=', '-o', 'args=']);
	const processes: ProcessInfo[] = [];
	for (const line of raw.split('\n')) {
		const match = line.match(/^\s*(\d+)\s+(.+)$/);
		if (match) {
			processes.push({ pid: parseInt(match[1], 10), commandLine: match[2] });
		}
	}
	return processes;
}

// `lsof -F n` prints one field per line; socket names look like "n127.0.0.1:56157" or "n*:34999".
async function listListeningPorts(pid: number): Promise<number[]> {
	const raw = await runCommand(
		LSOF,
		['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-F', 'n'],
		{ okExitCodes: [1] }
	);
	const ports = new Set<number>();
	for (const line of raw.split('\n')) {
		if (!line.startsWith('n')) {
			continue;
		}
		const port = parseInt(line.slice(line.lastIndexOf(':') + 1), 10);
		if (!Number.isNaN(port)) {
			ports.add(port);
		}
	}
	return Array.from(ports);
}

export function createPosixPlatform(options: PosixPlatformOptions): PlatformAdapter {
	return {
		name: options.name,
		async listUnityProcesses() {
			return (await listProcesses()).filter((p) => options.unityExecutable.test(p.commandLine));
		},
		listListeningPorts,
		editorLogPath: options.editorLogPath,
	};
}
