import * as path from 'path';
import * as vscode from 'vscode';
import { getPlatform } from '../platform';
import { probeDebuggerAgent } from './agentProbe';
import { resolveDebugCandidates, UnityDebugCandidate } from './unityProcess';

export const ATTACH_SESSION_NAME = 'Unity for Cursor: Attach to Unity Editor';

// Our own debugger type (declared in package.json's contributes.debuggers), distinct from
// ReSharper's "mono" type, so "Unity for Cursor" shows up as its own top-level entry in the
// debugger picker. resolveDebugConfiguration rewrites it to ReSharper's real "mono" type once the
// port is known.
export const UNITY_FOR_CURSOR_DEBUG_TYPE = 'unity-for-cursor-attach';

const DEBUGGER_HOST = '127.0.0.1';

interface AttachTarget {
	pid: number;
	port: number;
	projectPath: string;
}

type PortPickItem = vscode.QuickPickItem & AttachTarget;

// Picks the Editor + port to attach to from OS-level info only. The single-Editor case (the
// normal one once AssetImportWorkers are filtered out) resolves without prompting.
async function pickTarget(candidates: UnityDebugCandidate[]): Promise<AttachTarget | undefined> {
	if (!candidates.some((c) => c.listeningPorts.length > 0)) {
		vscode.window.showErrorMessage(
			'Unity for Cursor: 匹配到 Unity Editor 进程，但没有发现任何监听端口。请检查 Unity Preferences 里 "Editor Attaching" 开关是否开启。'
		);
		return undefined;
	}

	const [only] = candidates;
	if (candidates.length === 1 && only.listeningPorts.includes(only.formulaPort)) {
		return { pid: only.pid, port: only.formulaPort, projectPath: only.projectPath };
	}

	const items: PortPickItem[] = [];
	for (const c of candidates) {
		const base = { pid: c.pid, projectPath: c.projectPath };
		if (c.listeningPorts.includes(c.formulaPort)) {
			items.push({
				...base,
				port: c.formulaPort,
				label: `$(check) PID ${c.pid} — 端口 ${c.formulaPort}（符合 Unity 约定端口公式）`,
				description: c.projectPath,
			});
		}
		for (const port of c.listeningPorts.filter((p) => p !== c.formulaPort)) {
			items.push({
				...base,
				port,
				label: `PID ${c.pid} — 候选端口 ${port}`,
				description: `${c.projectPath} · 约定端口: ${c.formulaPort}`,
			});
		}
	}
	return vscode.window.showQuickPick(items, {
		title: 'Unity for Cursor: 选择要 attach 的端口',
		placeHolder: '优先选择标注"符合约定端口公式"的项',
	});
}

// Fails fast with an actionable message instead of letting ReSharper hang until its own timeout.
async function ensureAgentReady(port: number): Promise<boolean> {
	const result = await probeDebuggerAgent(DEBUGGER_HOST, port);
	switch (result.status) {
		case 'ready':
			return true;
		case 'refused':
			vscode.window.showErrorMessage(`Unity for Cursor: 无法连接 Unity 调试端口 ${port}：${result.message}`);
			return false;
		case 'unresponsive':
			vscode.window.showErrorMessage(
				`Unity for Cursor: Unity 调试端口 ${port} 无响应。可能已有其他调试器连接（Rider / 另一个 Cursor 窗口），` +
					'或上一次调试未正常断开导致 Unity 调试服务失效。请先断开其他调试器；仍无效则需要重启 Unity。'
			);
			return false;
	}
}

// Unity writes sequence-point paths for package code relative to the project root
// ("./Packages/…", "./Library/PackageCache/…"); Assets/ scripts are absolute. Without this map
// ReSharper can't resolve the relative ones, so breakpoints in package code never bind.
function sourceFileMapFor(projectPath: string): Record<string, string> {
	return { './': path.resolve(projectPath) + path.sep };
}

function toMonoAttachConfig(target: AttachTarget): vscode.DebugConfiguration {
	return {
		type: 'mono',
		request: 'attach',
		name: ATTACH_SESSION_NAME,
		address: DEBUGGER_HOST,
		port: target.port,
		sourceFileMap: sourceFileMapFor(target.projectPath),
		// ReSharper prints one Debug Console line per loaded assembly / missing symbol / thread
		// (700+ lines for a mid-size project) and the console would pop open on every attach.
		// It stays available from the panel; it just doesn't steal focus.
		internalConsoleOptions: 'neverOpen',
	};
}

export async function buildAttachConfig(folder: vscode.WorkspaceFolder): Promise<vscode.DebugConfiguration | undefined> {
	let candidates: UnityDebugCandidate[];
	try {
		candidates = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: '正在查找 Unity Editor 进程...' },
			() => resolveDebugCandidates(folder.uri.fsPath)
		);
	} catch (err) {
		vscode.window.showErrorMessage(
			`Unity for Cursor: 查找 Unity 进程失败 (${getPlatform().name}) - ${(err as Error).message}`
		);
		return undefined;
	}

	if (candidates.length === 0) {
		vscode.window.showErrorMessage('Unity for Cursor: 未找到与当前工程匹配的 Unity Editor 进程，请先打开 Unity。');
		return undefined;
	}

	const target = await pickTarget(candidates);
	if (!target || !(await ensureAgentReady(target.port))) {
		return undefined;
	}
	return toMonoAttachConfig(target);
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
	if (!started) {
		vscode.window.showErrorMessage(
			'Unity for Cursor: attach 未能启动。请确认 "C# by ReSharper" 是当前唯一注册的 C# 调试扩展' +
				'（禁用 C# Dev Kit 等冲突扩展后重载窗口），并检查 Unity Preferences 里的 Script Debugging 开关与防火墙设置。'
		);
	}
}

export class UnityAttachDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
	provideDebugConfigurations(): vscode.DebugConfiguration[] {
		return [{ type: UNITY_FOR_CURSOR_DEBUG_TYPE, request: 'attach', name: ATTACH_SESSION_NAME }];
	}

	// Every config handed to this provider is of our own dedicated type, so it's always ours.
	async resolveDebugConfiguration(
		folder: vscode.WorkspaceFolder | undefined
	): Promise<vscode.DebugConfiguration | null | undefined> {
		const target = folder ?? vscode.workspace.workspaceFolders?.[0];
		if (!target) {
			vscode.window.showErrorMessage('Unity for Cursor: 请先打开 Unity 工程所在的文件夹。');
			return null;
		}
		return (await buildAttachConfig(target)) ?? null;
	}
}
