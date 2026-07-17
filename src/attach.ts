import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveDebugCandidates, UnityDebugCandidate } from './unityProcess';

// Temporary diagnostic log: dumps every candidate/port resolution + the exact config handed
// to vscode.debug.startDebugging, so a failure can be root-caused from the resolved values
// instead of guessing what the extension actually passed downstream.
const DIAG_LOG_PATH = path.join(os.tmpdir(), 'unity-for-cursor-diag.log');

function diagLog(message: string): void {
	const line = `[${new Date().toISOString()}] ${message}\n`;
	try {
		fs.appendFileSync(DIAG_LOG_PATH, line);
	} catch {
		// best-effort diagnostics only
	}
}

type PortPickItem = vscode.QuickPickItem & { port: number };

// NOTE: never verify a candidate port by actually connecting to it here — Unity's mono
// debugger agent only services one connection per session, and spending it on a
// pre-attach probe makes the real attach fail. Selection is OS-info-only (formula port
// vs. listening ports), single-candidate cases are auto-resolved without prompting.
async function resolvePort(candidates: UnityDebugCandidate[]): Promise<number | undefined> {
	const anyListening = candidates.some((c) => c.listeningPorts.length > 0);
	if (!anyListening) {
		vscode.window.showErrorMessage(
			'Unity for Cursor: 匹配到 Unity Editor 进程，但没有发现任何监听端口。请检查 Unity Preferences 里 "Editor Attaching" 开关是否开启。'
		);
		return undefined;
	}

	if (candidates.length === 1 && candidates[0].listeningPorts.includes(candidates[0].formulaPort)) {
		return candidates[0].formulaPort;
	}

	const items: PortPickItem[] = [];
	for (const c of candidates) {
		if (c.listeningPorts.includes(c.formulaPort)) {
			items.push({
				label: `$(check) PID ${c.pid} — 端口 ${c.formulaPort}（符合 Unity 约定端口公式）`,
				description: c.projectPath,
				port: c.formulaPort,
			});
		}
		for (const p of c.listeningPorts) {
			if (p === c.formulaPort) {
				continue;
			}
			items.push({
				label: `PID ${c.pid} — 候选端口 ${p}`,
				description: `${c.projectPath} · 约定端口: ${c.formulaPort}`,
				port: p,
			});
		}
	}

	const picked = await vscode.window.showQuickPick(items, {
		title: 'Unity for Cursor: 选择要 attach 的端口',
		placeHolder: '优先选择标注"符合约定端口公式"的项',
	});

	return picked?.port;
}

// Our own debugger type (declared in package.json's contributes.debuggers), distinct from
// ReSharper's "mono" type. Having a dedicated type is what makes "Unity for Cursor" show up
// as its own top-level entry in the "Select debugger" / "Run and Debug" picker, instead of
// being nested under "More ReSharper: Mono options..." (which is where a config dynamically
// contributed to the existing "mono" type ends up). resolveDebugConfiguration below rewrites
// the config to the real "mono" type once the port is known, handing it off to ReSharper's
// actual debug adapter.
export const UNITY_FOR_CURSOR_DEBUG_TYPE = 'unity-for-cursor-attach';

export async function buildAttachConfig(folder: vscode.WorkspaceFolder): Promise<vscode.DebugConfiguration | undefined> {
	let candidates: UnityDebugCandidate[];
	try {
		candidates = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: '正在查找本机 Unity Editor 进程...' },
			() => resolveDebugCandidates(folder.uri.fsPath)
		);
	} catch (err) {
		vscode.window.showErrorMessage(`Unity for Cursor: 查找 Unity 进程失败 - ${(err as Error).message}`);
		return undefined;
	}

	diagLog(`candidates: ${JSON.stringify(candidates)}`);

	if (candidates.length === 0) {
		vscode.window.showErrorMessage('Unity for Cursor: 未找到与当前工程匹配的 Unity Editor 进程，请先打开 Unity。');
		return undefined;
	}

	const port = await resolvePort(candidates);
	if (port === undefined) {
		diagLog('resolvePort returned undefined, aborting');
		return undefined;
	}

	const config = {
		type: 'mono',
		request: 'attach',
		name: 'Unity for Cursor: Attach to Unity Editor',
		address: '127.0.0.1',
		port,
	};
	diagLog(`resolved config handed to startDebugging: ${JSON.stringify(config)}`);
	return config;
}

export async function attachToUnityEditor(): Promise<void> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		vscode.window.showErrorMessage('Unity for Cursor: 请先打开 Unity 工程所在的文件夹。');
		return;
	}

	const config = await buildAttachConfig(folder);
	if (!config) {
		return;
	}

	const started = await vscode.debug.startDebugging(folder, config);
	diagLog(`startDebugging(command palette path) returned: ${started}`);
	if (!started) {
		vscode.window.showErrorMessage(
			'Unity for Cursor: attach 未能启动。请确认 "C# by ReSharper" 是当前唯一注册的 C# 调试扩展' +
				'（禁用 C# Dev Kit 等冲突扩展后重载窗口），并检查 Unity Preferences 里的 Script Debugging 开关与防火墙设置。'
		);
	}
}

export class UnityAttachDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
	provideDebugConfigurations(): vscode.DebugConfiguration[] {
		return [
			{
				type: UNITY_FOR_CURSOR_DEBUG_TYPE,
				request: 'attach',
				name: 'Unity for Cursor: Attach to Unity Editor',
			},
		];
	}

	// Every config handed to this provider is of our own dedicated type, so it's always ours —
	// no marker property needed to distinguish it from the user's own launch.json entries.
	async resolveDebugConfiguration(
		folder: vscode.WorkspaceFolder | undefined,
		config: vscode.DebugConfiguration
	): Promise<vscode.DebugConfiguration | null | undefined> {
		diagLog(`resolveDebugConfiguration called with: ${JSON.stringify(config)}`);

		const target = folder ?? vscode.workspace.workspaceFolders?.[0];
		if (!target) {
			vscode.window.showErrorMessage('Unity for Cursor: 请先打开 Unity 工程所在的文件夹。');
			return null;
		}

		const resolved = await buildAttachConfig(target);
		return resolved ?? null;
	}
}
