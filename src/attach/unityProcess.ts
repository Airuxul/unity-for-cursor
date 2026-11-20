import * as path from 'path';
import { getPlatform, ProcessInfo } from '../platform';

export interface UnityDebugCandidate {
	pid: number;
	// Unity project root, as passed to the Editor via -projectPath.
	projectPath: string;
	// Unity's documented convention for the Editor's mono debugger port: 56000 + (PID % 1000).
	formulaPort: number;
	listeningPorts: number[];
}

// Unity's flag is "-projectpath" (case varies between launchers). Windows quotes the value;
// `ps` on macOS/Linux prints argv joined by spaces without quoting, so an unquoted value runs
// until the next " -flag" rather than the next space (paths with spaces are common on macOS).
function extractProjectPath(commandLine: string): string | undefined {
	const match = commandLine.match(/-projectpath\s+(?:"([^"]+)"|(.+?))(?=\s+-[A-Za-z]|\s*$)/i);
	return match ? (match[1] ?? match[2]).trim() : undefined;
}

// Unity spawns AssetImportWorker children with the same -projectPath, each running its own mono
// debugger agent on 56000 + (its PID % 1000). They're always started with -batchMode; the
// interactive Editor never is. Left in, they make the single-Editor case show a port picker.
function isBatchMode(commandLine: string): boolean {
	return /(?:^|\s)-batchmode(?:\s|$)/i.test(commandLine);
}

function normalizePath(p: string): string {
	return path.resolve(p).replace(/\\/g, '/').toLowerCase().replace(/\/$/, '');
}

// The Unity project may be the workspace folder itself or a subfolder of it — a repo root opened
// in Cursor with the Unity project in e.g. Client/ is a common layout.
function isInsideWorkspace(projectPath: string, workspacePath: string): boolean {
	const project = normalizePath(projectPath);
	const workspace = normalizePath(workspacePath);
	return project === workspace || project.startsWith(workspace + '/');
}

function toProjectEditor(proc: ProcessInfo, workspacePath: string): { pid: number; projectPath: string } | undefined {
	if (isBatchMode(proc.commandLine)) {
		return undefined;
	}
	const projectPath = extractProjectPath(proc.commandLine);
	if (!projectPath || !isInsideWorkspace(projectPath, workspacePath)) {
		return undefined;
	}
	return { pid: proc.pid, projectPath };
}

// Candidates are resolved purely from OS process/port info. Connecting to a port to check it is
// only safe through probeDebuggerAgent() (see agentProbe.ts), which disconnects cleanly.
export async function resolveDebugCandidates(workspacePath: string): Promise<UnityDebugCandidate[]> {
	const platform = getPlatform();
	const editors = (await platform.listUnityProcesses())
		.map((proc) => toProjectEditor(proc, workspacePath))
		.filter((editor): editor is { pid: number; projectPath: string } => editor !== undefined);

	// Port lookups are independent per process (and each spawns a child process), so run them
	// concurrently.
	const portsPerEditor = await Promise.all(editors.map((e) => platform.listListeningPorts(e.pid)));
	return editors.map((editor, i) => ({
		...editor,
		formulaPort: 56000 + (editor.pid % 1000),
		listeningPorts: portsPerEditor[i],
	}));
}
