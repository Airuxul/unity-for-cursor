import * as vscode from 'vscode';
import { ATTACH_SESSION_NAME, LastAttachInfo, buildAttachConfig, getLastResolvedAttach } from './attach';
import { getPortCreationTime, isProcessAlive } from './unityProcess';

const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 25000;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// Distinguishing "Unity did a Domain Reload" from "the user clicked Stop/Disconnect" purely
// from session-termination is unreliable: attach-mode disconnects don't kill Unity, so the
// process stays alive in both cases. What's reliable is the mono debugger agent's listening
// socket itself — a Domain Reload tears down and re-opens it, giving it a new CreationTime even
// if the port number is reused, while a plain client disconnect leaves the original socket
// exactly as-is. We compare CreationTime across polls rather than just checking "is it listening
// again after being gone" — a fast/optimized Domain Reload (sub-second) can tear down and
// recreate the socket entirely between two 1-second polls, so two consecutive "yes, listening"
// observations could still be straddling a reload the old drop-then-recover check would miss
// entirely.
async function waitForReload(pid: number, knownPort: number): Promise<boolean> {
	const deadline = Date.now() + POLL_TIMEOUT_MS;
	const baseline = await getPortCreationTime(pid, knownPort);
	while (Date.now() < deadline) {
		await sleep(POLL_INTERVAL_MS);
		if (!(await isProcessAlive(pid))) {
			return false;
		}
		const current = await getPortCreationTime(pid, knownPort);
		if (current !== undefined && current !== baseline) {
			return true;
		}
	}
	return false;
}

export function registerAutoReattach(context: vscode.ExtensionContext): void {
	let tracked: LastAttachInfo | undefined;

	context.subscriptions.push(
		vscode.debug.onDidStartDebugSession((session) => {
			if (session.type === 'mono' && session.name === ATTACH_SESSION_NAME) {
				tracked = getLastResolvedAttach();
			}
		}),
		vscode.debug.onDidTerminateDebugSession(async (session) => {
			if (session.type !== 'mono' || session.name !== ATTACH_SESSION_NAME || !tracked) {
				return;
			}
			const { folder, pid, port } = tracked;
			tracked = undefined;

			if (!(await isProcessAlive(pid))) {
				return;
			}

			const reloaded = await waitForReload(pid, port);
			if (!reloaded) {
				// Only reachable via the 25s timeout (isProcessAlive-false returns early above
				// without going through here) — large projects can easily take longer than that
				// to finish a Domain Reload, and the user has no other signal that auto-reattach
				// was even attempted, let alone that it gave up.
				vscode.window.setStatusBarMessage(
					'$(warning) Unity for Cursor: 未在 25 秒内检测到 Domain Reload 完成，自动重连已放弃，请手动 attach',
					6000
				);
				return;
			}

			vscode.window.setStatusBarMessage(
				'$(sync~spin) Unity for Cursor: 检测到 Domain Reload，正在自动重连...',
				5000
			);
			const resolved = await buildAttachConfig(folder);
			if (!resolved) {
				return;
			}
			const started = await vscode.debug.startDebugging(folder, resolved.config);
			vscode.window.setStatusBarMessage(
				started
					? '$(check) Unity for Cursor: 已自动重连'
					: '$(error) Unity for Cursor: 自动重连失败，请手动 attach',
				5000
			);
		})
	);
}
