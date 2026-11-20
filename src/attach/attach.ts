import * as path from 'path';
import * as vscode from 'vscode';
import { getPlatform } from '../platform';
import { probeDebuggerAgent } from './agentProbe';
import { resolveDebugCandidates, UnityDebugCandidate } from './unityProcess';
import { discoverPlayers, PlayerCandidate } from './discoverPlayers';
import { AttachTarget, attachSessionName, attachTargetLabel } from './attachTarget';

type TargetPickItem = vscode.QuickPickItem & { target: AttachTarget };

// Our own debugger type (declared in package.json's contributes.debuggers), distinct from
// ReSharper's "mono" type, so "Unity for Cursor" shows up as its own top-level entry in the
// debugger picker. `runAttachFlow` starts the selected session itself, so
// `resolveDebugConfiguration` always returns `undefined`.
export const UNITY_FOR_CURSOR_DEBUG_TYPE = 'unity-for-cursor-attach';

const LOCAL_DEBUGGER_HOST = '127.0.0.1';

// Editor candidates come from OS-level listening-port info only. A candidate whose formula port
// is listening contributes just that port; otherwise every listening port is offered.
function editorCandidateToTargets(candidates: UnityDebugCandidate[]): AttachTarget[] {
	const targets: AttachTarget[] = [];
	for (const c of candidates) {
		const base = { kind: 'editor' as const, pid: c.pid, projectPath: c.projectPath };
		if (c.listeningPorts.includes(c.formulaPort)) {
			targets.push({ ...base, port: c.formulaPort });
			continue;
		}
		for (const p of c.listeningPorts) {
			targets.push({ ...base, port: p });
		}
	}
	return targets;
}

function playerCandidateToTargets(candidates: PlayerCandidate[]): AttachTarget[] {
	return candidates.map((c) => ({ kind: 'player', label: c.label, address: c.address, port: c.port }));
}

function targetPickItem(target: AttachTarget, candidates: UnityDebugCandidate[]): TargetPickItem {
	if (target.kind === 'editor') {
		const candidate = candidates.find((c) => c.pid === target.pid);
		const isFormulaPort = candidate?.formulaPort === target.port;
		return {
			label: `$(circuit-board) ${attachTargetLabel(target)} — 端口 ${target.port}${
				isFormulaPort ? '（符合 Unity 约定端口公式）' : ''
			}`,
			description: target.projectPath,
			target,
		};
	}
	return {
		label: `$(radio-tower) ${attachTargetLabel(target)} — ${target.address}:${target.port}`,
		description: target.address,
		target,
	};
}

// Discovers every attachable target (local Editor processes matching this workspace, plus any
// Player/device broadcasting over multicast) and lets the user pick ONE — matching Rider's
// "Attach to Unity Process" flow, where attaching to several targets means running the command
// again. Auto-resolves without prompting only when there's exactly one target in total.
async function selectAttachTarget(workspacePath: string): Promise<AttachTarget | undefined> {
	let editorCandidates: UnityDebugCandidate[];
	let playerCandidates: PlayerCandidate[];
	try {
		[editorCandidates, playerCandidates] = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: '正在查找本机 Unity Editor 进程和局域网 Player...' },
			() => Promise.all([resolveDebugCandidates(workspacePath), discoverPlayers()])
		);
	} catch (err) {
		vscode.window.showErrorMessage(
			`Unity for Cursor: 查找 Unity 进程失败 (${getPlatform().name}) - ${(err as Error).message}`
		);
		return undefined;
	}

	const anyEditorListening = editorCandidates.some((c) => c.listeningPorts.length > 0);
	const targets = [
		...(anyEditorListening ? editorCandidateToTargets(editorCandidates) : []),
		...playerCandidateToTargets(playerCandidates),
	];

	if (targets.length === 0) {
		vscode.window.showErrorMessage(
			editorCandidates.length > 0
				? 'Unity for Cursor: 匹配到 Unity Editor 进程，但没有发现任何监听端口。请检查 Unity Preferences 里 "Editor Attaching" 开关是否开启。'
				: '未找到与当前工程匹配的 Unity Editor 进程，也没有发现广播中的 Player。请先打开 Unity 或确认 Player 已启用 Script Debugging。'
		);
		return undefined;
	}

	if (targets.length === 1) {
		return targets[0];
	}

	const items = targets.map((t) => targetPickItem(t, editorCandidates));
	const picked = await vscode.window.showQuickPick(items, {
		title: 'Unity for Cursor: 选择要 attach 的目标',
		placeHolder: '需要同时调试多个目标时，attach 完成后再次运行本命令并选择另一个目标',
	});
	return picked?.target;
}

function debuggerHost(target: AttachTarget): string {
	return target.kind === 'editor' ? LOCAL_DEBUGGER_HOST : target.address;
}

// Fails fast with an actionable message instead of letting ReSharper hang until its own timeout.
async function ensureAgentReady(target: AttachTarget): Promise<boolean> {
	const where = `${attachTargetLabel(target)} 的调试端口 ${target.port}`;
	const result = await probeDebuggerAgent(debuggerHost(target), target.port);
	switch (result.status) {
		case 'ready':
			return true;
		case 'refused':
			vscode.window.showErrorMessage(`Unity for Cursor: 无法连接 ${where}：${result.message}`);
			return false;
		case 'unresponsive':
			vscode.window.showErrorMessage(
				`Unity for Cursor: ${where} 无响应。可能已有其他调试器连接（Rider / 另一个 Cursor 窗口），` +
					'或上一次调试未正常断开导致 Unity 调试服务失效。请先断开其他调试器；仍无效则需要重启 Unity 或 Player。'
			);
			return false;
	}
}

// Unity writes sequence-point paths for package code relative to the project root
// ("./Packages/…", "./Library/PackageCache/…"); Assets/ scripts are absolute. Without this map
// ReSharper can't resolve the relative ones, so breakpoints in package code never bind.
// Only known for Editor targets: a Player doesn't announce which project it was built from.
function sourceFileMapFor(projectPath: string): Record<string, string> {
	return { './': path.resolve(projectPath) + path.sep };
}

function toDebugConfiguration(target: AttachTarget): vscode.DebugConfiguration {
	return {
		type: 'mono',
		request: 'attach',
		name: attachSessionName(target),
		address: debuggerHost(target),
		port: target.port,
		...(target.kind === 'editor' ? { sourceFileMap: sourceFileMapFor(target.projectPath) } : {}),
		// ReSharper prints one Debug Console line per loaded assembly / missing symbol / thread
		// (700+ lines for a mid-size project) and the console would pop open on every attach.
		// It stays available from the panel; it just doesn't steal focus.
		internalConsoleOptions: 'neverOpen',
	};
}

async function startAttachSession(target: AttachTarget, folder: vscode.WorkspaceFolder): Promise<boolean> {
	const started = await vscode.debug.startDebugging(folder, toDebugConfiguration(target));
	if (!started) {
		vscode.window.showErrorMessage(
			`Unity for Cursor: attach 到 ${attachTargetLabel(target)} 未能启动。请确认 "C# by ReSharper" 是当前唯一注册的 ` +
				'C# 调试扩展（禁用 C# Dev Kit 等冲突扩展后重载窗口），并检查目标的 Script Debugging 开关与防火墙设置。'
		);
	}
	return started;
}

// Shared by both the command-palette entry point and the debug-picker/launch.json entry point.
export async function runAttachFlow(): Promise<void> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		vscode.window.showErrorMessage('Unity for Cursor: 请先打开 Unity 工程所在的文件夹。');
		return;
	}

	const target = await selectAttachTarget(folder.uri.fsPath);
	if (!target || !(await ensureAgentReady(target))) {
		return;
	}

	await startAttachSession(target, folder);
}

export class UnityAttachDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
	provideDebugConfigurations(): vscode.DebugConfiguration[] {
		return [
			{
				name: 'Unity for Cursor: Attach to Unity (Editor/Player)',
				type: UNITY_FOR_CURSOR_DEBUG_TYPE,
				request: 'attach',
			},
		];
	}

	// Every config handed to this provider is of our own dedicated type, so it's always ours.
	// Always resolves to `undefined`: `runAttachFlow` starts the selected session itself.
	async resolveDebugConfiguration(): Promise<vscode.DebugConfiguration | null | undefined> {
		await runAttachFlow();
		return undefined;
	}
}
