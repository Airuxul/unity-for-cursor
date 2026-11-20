// Everything OS-specific the extension needs, behind one interface. Callers never branch on
// process.platform themselves — they ask getPlatform() (see ./index.ts) for the adapter.
//
// To support a new OS: implement PlatformAdapter in its own file and add one case to
// createPlatform() in ./index.ts.

export interface ProcessInfo {
	pid: number;
	// Full command line, executable path first. Used to read Unity's -projectPath / -batchMode.
	commandLine: string;
}

export interface PlatformAdapter {
	// Short human-readable name used in error messages, e.g. "macOS".
	readonly name: string;

	// Every running Unity Editor process (including AssetImportWorker children — filtering is the
	// caller's job, since it's identical on every OS).
	listUnityProcesses(): Promise<ProcessInfo[]>;

	// TCP ports `pid` is listening on. Empty if none or if the process is gone.
	listListeningPorts(pid: number): Promise<number[]>;

	// Absolute path of the Unity Editor's Editor.log.
	editorLogPath(): string;
}
