import { execFile } from 'child_process';
import * as path from 'path';

function runPowerShell(command: string): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			'powershell',
			['-NoProfile', '-NonInteractive', '-Command', command],
			{ maxBuffer: 10 * 1024 * 1024 },
			(err, stdout, stderr) => {
				if (err) {
					reject(new Error(stderr || err.message));
					return;
				}
				resolve(stdout);
			}
		);
	});
}

interface UnityProcessRow {
	pid: number;
	commandLine: string;
}

async function findUnityProcesses(): Promise<UnityProcessRow[]> {
	const raw = await runPowerShell(
		"Get-CimInstance Win32_Process -Filter \"Name='Unity.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"
	);
	const trimmed = raw.trim();
	if (!trimmed) {
		return [];
	}
	const parsed = JSON.parse(trimmed);
	const rows = Array.isArray(parsed) ? parsed : [parsed];
	return rows
		.filter((row) => row && typeof row.ProcessId === 'number')
		.map((row) => ({ pid: row.ProcessId as number, commandLine: (row.CommandLine as string) ?? '' }));
}

// Unity's actual CLI flag is lower-case "-projectpath" (confirmed against a live process).
function extractProjectPath(commandLine: string): string | undefined {
	const match = commandLine.match(/-projectpath\s+("([^"]+)"|(\S+))/i);
	if (!match) {
		return undefined;
	}
	return match[2] ?? match[3];
}

function normalizePath(p: string): string {
	return path.resolve(p).replace(/\\/g, '/').toLowerCase().replace(/\/$/, '');
}

async function findUnityProcessesForProject(
	workspacePath: string
): Promise<Array<{ pid: number; projectPath: string }>> {
	const processes = await findUnityProcesses();
	const target = normalizePath(workspacePath);
	const matches: Array<{ pid: number; projectPath: string }> = [];
	for (const proc of processes) {
		const projectPath = extractProjectPath(proc.commandLine);
		if (projectPath && normalizePath(projectPath) === target) {
			matches.push({ pid: proc.pid, projectPath });
		}
	}
	return matches;
}

async function getListeningPorts(pid: number): Promise<number[]> {
	const raw = await runPowerShell(
		`Get-NetTCPConnection -OwningProcess ${pid} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort`
	);
	return raw
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => parseInt(line, 10))
		.filter((n) => !Number.isNaN(n));
}

// IMPORTANT: do NOT probe candidate ports by actually connecting (e.g. a DWP-Handshake
// exchange) before the real debug adapter attaches. Unity's embedded mono debugger agent
// (server=y,suspend=n) only ever services a single incoming connection per Editor session —
// confirmed empirically: a prior handshake probe against a port succeeds, but the *subsequent*
// real ReSharper attach to that same port then fails every time (SocketException 10060,
// handshake receive timeout), because the one-shot connection slot was already spent by our
// own probe. So candidates are resolved purely from OS-level listening-port info; the formula
// port is used as the best-guess match without ever touching the socket.
export interface UnityDebugCandidate {
	pid: number;
	projectPath: string;
	// Unity's documented convention: 56000 + (Editor PID % 1000).
	formulaPort: number;
	listeningPorts: number[];
}

export async function resolveDebugCandidates(workspacePath: string): Promise<UnityDebugCandidate[]> {
	const matches = await findUnityProcessesForProject(workspacePath);
	const candidates: UnityDebugCandidate[] = [];
	for (const match of matches) {
		const formulaPort = 56000 + (match.pid % 1000);
		const listeningPorts = await getListeningPorts(match.pid);
		candidates.push({
			pid: match.pid,
			projectPath: match.projectPath,
			formulaPort,
			listeningPorts,
		});
	}
	return candidates;
}
