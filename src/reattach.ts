import * as vscode from 'vscode';
import { ATTACH_SESSION_NAME, LastAttachInfo, buildAttachConfig, getLastResolvedAttach } from './attach';
import { getListeningPorts, isProcessAlive } from './unityProcess';

const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 25000;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// Distinguishing "Unity did a Domain Reload" from "the user clicked Stop/Disconnect" purely
// from session-termination is unreliable: attach-mode disconnects don't kill Unity, so the
// process stays alive in both cases. What's reliable is the mono debugger agent's listening
// socket itself — a Domain Reload restarts Unity's mono runtime, which tears down and
// re-opens that socket, while a plain client disconnect leaves it exactly as-is (still
// listed as Listen, just no longer accepting a fresh handshake — see resolvePort's notes on
// the one-shot connection). So we only treat this as a reload if we actually observe the
// known port disappear and then come back; otherwise we give up silently.
async function waitForReload(pid: number, knownPort: number): Promise<boolean> {
	const deadline = Date.now() + POLL_TIMEOUT_MS;
	let sawDrop = false;
	while (Date.now() < deadline) {
		if (!(await isProcessAlive(pid))) {
			return false;
		}
		const stillListening = (await getListeningPorts(pid)).includes(knownPort);
		if (!sawDrop) {
			sawDrop = !stillListening;
		} else if (stillListening) {
			return true;
		}
		await sleep(POLL_INTERVAL_MS);
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
