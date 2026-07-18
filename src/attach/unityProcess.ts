import { execFile } from 'child_process';
import * as path from 'path';

function runPowerShell(command: string): Promise<string> {
	// PowerShell's stdout pipe defaults to the OS codepage, not UTF-8 — Node's execFile decodes
	// it as utf8 regardless, so a non-ASCII byte (Chinese username/path — this extension's own
	// UI is all Chinese, implying a userbase where that's common) comes through mangled. Forcing
	// [Console]::OutputEncoding to UTF8 before the real command makes PowerShell's own pipe
	// writes match what Node expects.
	const fullCommand = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${command}`;
	return new Promise((resolve, reject) => {
		execFile(
			'powershell',
			['-NoProfile', '-NonInteractive', '-Command', fullCommand],
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

export async function getListeningPorts(pid: number): Promise<number[]> {
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

export async function isProcessAlive(pid: number): Promise<boolean> {
	const raw = await runPowerShell(
		`Get-Process -Id ${pid} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id`
	);
	return raw.trim() === String(pid);
}

// The socket's own creation timestamp, in .NET Ticks (returned as a plain integer string so we
// don't need a second PowerShell round trip to parse a date format). A Domain Reload tears down
// and re-opens the mono debugger's listening socket, which gets a new CreationTime even if the
// port number itself is reused — this lets callers detect "the socket was recreated" as an
// identity change rather than needing to directly observe an absence-then-presence transition,
// which a fast/optimized Domain Reload can complete entirely between two polls. Returns
// undefined if the pid has no listener on that port at all right now.
export async function getPortCreationTime(pid: number, port: number): Promise<number | undefined> {
	const raw = await runPowerShell(
		`(Get-NetTCPConnection -OwningProcess ${pid} -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ` +
			'Select-Object -First 1 -ExpandProperty CreationTime).Ticks'
	);
	const trimmed = raw.trim();
	if (!trimmed) {
		return undefined;
	}
	const ticks = Number(trimmed);
	return Number.isNaN(ticks) ? undefined : ticks;
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
	// Each getListeningPorts call spawns its own powershell.exe (see runPowerShell), so awaiting
	// them one at a time in a loop pays that per-process startup cost serially once per matched
	// Unity instance. Independent per-pid, so run them concurrently instead.
	const listeningPortsByMatch = await Promise.all(matches.map((match) => getListeningPorts(match.pid)));
	return matches.map((match, i) => ({
		pid: match.pid,
		projectPath: match.projectPath,
		formulaPort: 56000 + (match.pid % 1000),
		listeningPorts: listeningPortsByMatch[i],
	}));
}
