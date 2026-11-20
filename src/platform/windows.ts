import * as os from 'os';
import * as path from 'path';
import { runCommand } from './exec';
import { PlatformAdapter, ProcessInfo } from './types';

// PowerShell's stdout pipe defaults to the OS codepage, not UTF-8 — Node decodes it as UTF-8
// regardless, so non-ASCII text (e.g. a Chinese user name in a project path) comes through
// mangled. Forcing [Console]::OutputEncoding first makes both sides agree.
function runPowerShell(command: string): Promise<string> {
	const script = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${command}`;
	return runCommand('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
}

function parseIntegerLines(raw: string): number[] {
	return raw
		.split(/\r?\n/)
		.map((line) => parseInt(line.trim(), 10))
		.filter((n) => !Number.isNaN(n));
}

export const windowsPlatform: PlatformAdapter = {
	name: 'Windows',

	async listUnityProcesses(): Promise<ProcessInfo[]> {
		const raw = await runPowerShell(
			"Get-CimInstance Win32_Process -Filter \"Name='Unity.exe'\" | " +
				'Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress'
		);
		const trimmed = raw.trim();
		if (!trimmed) {
			return [];
		}
		// ConvertTo-Json emits a bare object (not an array) when there is exactly one match.
		const parsed = JSON.parse(trimmed);
		const rows: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
		return rows
			.filter((row): row is { ProcessId: number; CommandLine?: string } =>
				typeof (row as { ProcessId?: unknown })?.ProcessId === 'number'
			)
			.map((row) => ({ pid: row.ProcessId, commandLine: row.CommandLine ?? '' }));
	},

	async listListeningPorts(pid: number): Promise<number[]> {
		const raw = await runPowerShell(
			`Get-NetTCPConnection -OwningProcess ${pid} -State Listen -ErrorAction SilentlyContinue | ` +
				'Select-Object -ExpandProperty LocalPort'
		);
		return parseIntegerLines(raw);
	},

	editorLogPath(): string {
		return path.join(os.homedir(), 'AppData', 'Local', 'Unity', 'Editor', 'Editor.log');
	},
};
