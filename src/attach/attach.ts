import * as vscode from 'vscode';
import { resolveDebugCandidates, UnityDebugCandidate } from './unityProcess';

export const ATTACH_SESSION_NAME = 'Unity for Cursor: Attach to Unity Editor';

type PortPickItem = vscode.QuickPickItem & { port: number; pid: number };

// NOTE: never verify a candidate port by actually connecting to it here — Unity's mono
// debugger agent only services one connection per session, and spending it on a
// pre-attach probe makes the real attach fail. Selection is OS-info-only (formula port
// vs. listening ports), single-candidate cases are auto-resolved without prompting.
async function resolvePort(candidates: UnityDebugCandidate[]): Promise<{ port: number; pid: number } | undefined> {
	const anyListening = candidates.some((c) => c.listeningPorts.length > 0);
	if (!anyListening) {
		vscode.window.showErrorMessage(
			'Unity for Cursor: 匹配到 Unity Editor 进程，但没有发现任何监听端口。请检查 Unity Preferences 里 "Editor Attaching" 开关是否开启。'
		);
		return undefined;
	}

	if (candidates.length === 1 && candidates[0].listeningPorts.includes(candidates[0].formulaPort)) {
		return { port: candidates[0].formulaPort, pid: candidates[0].pid };
	}

	const items: PortPickItem[] = [];
	for (const c of candidates) {
		if (c.listeningPorts.includes(c.formulaPort)) {
			items.push({
				label: `$(check) PID ${c.pid} — 端口 ${c.formulaPort}（符合 Unity 约定端口公式）`,
				description: c.projectPath,
				port: c.formulaPort,
				pid: c.pid,
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
				pid: c.pid,
			});
		}
	}

	const picked = await vscode.window.showQuickPick(items, {
		title: 'Unity for Cursor: 选择要 attach 的端口',
		placeHolder: '优先选择标注"符合约定端口公式"的项',
	});

	return picked ? { port: picked.port, pid: picked.pid } : undefined;
}

// Our own debugger type (declared in package.json's contributes.debuggers), distinct from
// ReSharper's "mono" type. Having a dedicated type is what makes "Unity for Cursor" show up
// as its own top-level entry in the "Select debugger" / "Run and Debug" picker, instead of
// being nested under "More ReSharper: Mono options..." (which is where a config dynamically
// contributed to the existing "mono" type ends up). resolveDebugConfiguration below rewrites
// the config to the real "mono" type once the port is known, handing it off to ReSharper's
// actual debug adapter.
export const UNITY_FOR_CURSOR_DEBUG_TYPE = 'unity-for-cursor-attach';

export interface ResolvedAttach {
	config: vscode.DebugConfiguration;
	pid: number;
}

export interface LastAttachInfo {
	folder: vscode.WorkspaceFolder;
	pid: number;
	port: number;
}

// Populated as a side effect of every successful buildAttachConfig() call, regardless of
// whether it was reached via the command-palette path or the debug-picker path. reattach.ts
// reads this right after our session starts so it knows which Unity process/port to watch
// for a Domain Reload disconnect.
let lastResolvedAttach: LastAttachInfo | undefined;

export function getLastResolvedAttach(): LastAttachInfo | undefined {
	return lastResolvedAttach;
}

export async function buildAttachConfig(folder: vscode.WorkspaceFolder): Promise<ResolvedAttach | undefined> {
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

	if (candidates.length === 0) {
		vscode.window.showErrorMessage('Unity for Cursor: 未找到与当前工程匹配的 Unity Editor 进程，请先打开 Unity。');
		return undefined;
	}

	const resolved = await resolvePort(candidates);
	if (!resolved) {
		return undefined;
	}

	const config: vscode.DebugConfiguration = {
		type: 'mono',
		request: 'attach',
		name: ATTACH_SESSION_NAME,
		address: '127.0.0.1',
		port: resolved.port,
	};

	lastResolvedAttach = { folder, pid: resolved.pid, port: resolved.port };
	return { config, pid: resolved.pid };
}

export async function attachToUnityEditor(): Promise<void> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		vscode.window.showErrorMessage('Unity for Cursor: 请先打开 Unity 工程所在的文件夹。');
		return;
	}

	const resolved = await buildAttachConfig(folder);
	if (!resolved) {
		return;
	}

	const started = await vscode.debug.startDebugging(folder, resolved.config);
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
				name: ATTACH_SESSION_NAME,
			},
		];
	}

	// Every config handed to this provider is of our own dedicated type, so it's always ours —
	// no marker property needed to distinguish it from the user's own launch.json entries.
	async resolveDebugConfiguration(
		folder: vscode.WorkspaceFolder | undefined,
		_config: vscode.DebugConfiguration
	): Promise<vscode.DebugConfiguration | null | undefined> {
		const target = folder ?? vscode.workspace.workspaceFolders?.[0];
		if (!target) {
			vscode.window.showErrorMessage('Unity for Cursor: 请先打开 Unity 工程所在的文件夹。');
			return null;
		}

		const resolved = await buildAttachConfig(target);
		return resolved?.config ?? null;
	}
}
