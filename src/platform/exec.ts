import { execFile } from 'child_process';

const MAX_BUFFER = 10 * 1024 * 1024;

export interface RunOptions {
	// Exit codes that still count as success. lsof, for example, exits 1 when its filter simply
	// matched nothing — that's an empty result, not a failure.
	okExitCodes?: number[];
}

// Runs an executable directly (no shell), so arguments never need quoting or escaping.
export function runCommand(file: string, args: string[], options: RunOptions = {}): Promise<string> {
	const okExitCodes = options.okExitCodes ?? [];
	return new Promise((resolve, reject) => {
		execFile(file, args, { maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
			if (!err) {
				resolve(stdout);
				return;
			}
			const exitCode = (err as { code?: unknown }).code;
			if (typeof exitCode === 'number' && okExitCodes.includes(exitCode)) {
				resolve(stdout);
				return;
			}
			reject(new Error(stderr || err.message));
		});
	});
}
