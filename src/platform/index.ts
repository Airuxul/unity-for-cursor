import * as os from 'os';
import * as path from 'path';
import { createPosixPlatform } from './posix';
import { PlatformAdapter } from './types';
import { windowsPlatform } from './windows';

export { PlatformAdapter, ProcessInfo } from './types';

// Editor.log locations are Unity's documented defaults for each OS.
function createPlatform(platform: NodeJS.Platform): PlatformAdapter | undefined {
	switch (platform) {
		case 'win32':
			return windowsPlatform;
		case 'darwin':
			return createPosixPlatform({
				name: 'macOS',
				unityExecutable: /^\S*\/Unity\.app\/Contents\/MacOS\/Unity(?:\s|$)/,
				editorLogPath: () => path.join(os.homedir(), 'Library', 'Logs', 'Unity', 'Editor.log'),
			});
		case 'linux':
			return createPosixPlatform({
				name: 'Linux',
				unityExecutable: /^\S*\/Editor\/Unity(?:\s|$)/,
				editorLogPath: () => path.join(os.homedir(), '.config', 'unity3d', 'Editor.log'),
			});
		default:
			return undefined;
	}
}

let cached: PlatformAdapter | undefined;

export function getPlatform(): PlatformAdapter {
	if (!cached) {
		const adapter = createPlatform(process.platform);
		if (!adapter) {
			throw new Error(`Unity for Cursor 暂不支持当前操作系统 (${process.platform})`);
		}
		cached = adapter;
	}
	return cached;
}
