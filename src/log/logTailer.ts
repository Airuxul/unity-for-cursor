import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import chokidar, { FSWatcher } from 'chokidar';

// Unity runtime stack-trace frames look like: "MyScript.Update () (at Assets/Scripts/MyScript.cs:42)".
const STACK_FRAME_PATTERN = /\(at ([^()\r\n]+):(\d+)\)/g;
// Unity compiler diagnostics look like: "Assets/Scripts/MyScript.cs(42,10): error CS0246: ...".
const COMPILER_DIAGNOSTIC_PATTERN = /([^\s():]+\.cs)\((\d+),(\d+)\):\s*(?:error|warning)\s+CS\d+/g;

const ERROR_BLOCK_PATTERN = /error CS\d+|UnityEngine\.Debug:LogError|UnityEngine\.Debug:LogException|\bException\b.*?:/;
const WARNING_BLOCK_PATTERN = /warning CS\d+|UnityEngine\.Debug:LogWarning/;

// Unity sometimes appends a standalone diagnostic suffix line like
// "(Filename: Assets/Game/LogManager.cs Line: 236)", separated from the real message by a blank
// line — it belongs to the entry above it, not a new entry of its own.
const FILENAME_MARKER_PATTERN = /^\(Filename:\s*.*?\s*Line:\s*\d+\)$/;

export const MAX_ENTRIES = 5000;

export type LogLevel = 'error' | 'warning' | 'info';

export interface LogLink {
	start: number;
	end: number;
	file: string;
	line: number;
}

export interface LogEntry {
	id: number;
	level: LogLevel;
	text: string;
	receivedAt: number;
	links: LogLink[];
}

function getEditorLogPath(): string {
	return path.join(os.homedir(), 'AppData', 'Local', 'Unity', 'Editor', 'Editor.log');
}

function classifyBlock(block: string): LogLevel {
	if (ERROR_BLOCK_PATTERN.test(block)) {
		return 'error';
	}
	if (WARNING_BLOCK_PATTERN.test(block)) {
		return 'warning';
	}
	return 'info';
}

function scanLinks(text: string): LogLink[] {
	const links: LogLink[] = [];

	STACK_FRAME_PATTERN.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = STACK_FRAME_PATTERN.exec(text))) {
		const [full, file, lineStr] = match;
		links.push({
			start: match.index,
			end: match.index + full.length,
			file,
			line: parseInt(lineStr, 10),
		});
	}

	COMPILER_DIAGNOSTIC_PATTERN.lastIndex = 0;
	while ((match = COMPILER_DIAGNOSTIC_PATTERN.exec(text))) {
		const [full, file, lineStr] = match;
		links.push({
			start: match.index,
			end: match.index + full.length,
			file,
			line: parseInt(lineStr, 10),
		});
	}

	links.sort((a, b) => a.start - b.start);
	return links;
}

export class EditorLogTailer implements vscode.Disposable {
	private entries: LogEntry[] = [];
	private nextId = 1;
	private lastEntryId: number | undefined;
	private offset = 0;
	private pending = false;
	// Unity's log blocks are separated by blank lines; a chunk boundary can split the last
	// block in two, so we hold it back until the next pump instead of misclassifying it.
	private carry = '';
	private watcher: FSWatcher | undefined;

	private readonly entriesEmitter = new vscode.EventEmitter<LogEntry[]>();
	private readonly updateEmitter = new vscode.EventEmitter<{ id: number; appendText: string }>();

	readonly onEntries = this.entriesEmitter.event;
	readonly onUpdateEntry = this.updateEmitter.event;

	constructor() {
		try {
			this.watcher = chokidar.watch(getEditorLogPath(), {
				awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 20 },
				ignoreInitial: true,
			});
			this.watcher
				.on('add', () => this.pump())
				.on('change', () => this.pump())
				.on('unlink', () => (this.offset = 0));
		} catch {
			// Unity has never run on this machine — the log directory doesn't exist yet.
		}
		this.pump();
	}

	getSnapshot(): LogEntry[] {
		return this.entries;
	}

	clearBuffer(): void {
		this.entries = [];
		this.lastEntryId = undefined;
	}

	dispose(): void {
		void this.watcher?.close();
		this.entriesEmitter.dispose();
		this.updateEmitter.dispose();
	}

	private addEntry(block: string, batch: LogEntry[]): void {
		const level = classifyBlock(block);
		const entry: LogEntry = {
			id: this.nextId++,
			level,
			text: block,
			receivedAt: Date.now(),
			links: scanLinks(block),
		};
		this.entries.push(entry);
		if (this.entries.length > MAX_ENTRIES) {
			this.entries.shift();
		}
		this.lastEntryId = entry.id;
		batch.push(entry);
	}

	private logBlock(block: string, batch: LogEntry[]): void {
		const trimmed = block.trim();
		if (!trimmed) {
			return;
		}
		if (FILENAME_MARKER_PATTERN.test(trimmed) && this.lastEntryId !== undefined) {
			const target = this.entries.find((e) => e.id === this.lastEntryId);
			if (target) {
				target.text += '\n' + trimmed;
			}
			this.updateEmitter.fire({ id: this.lastEntryId, appendText: trimmed });
			return;
		}
		this.addEntry(block, batch);
	}

	private emit(text: string): void {
		const combined = this.carry + text;
		const blocks = combined.split(/\r?\n\r?\n+/);
		this.carry = blocks.pop() ?? '';
		const batch: LogEntry[] = [];
		for (const block of blocks) {
			this.logBlock(block, batch);
		}
		if (batch.length > 0) {
			this.entriesEmitter.fire(batch);
		}
	}

	private flushCarry(): void {
		const batch: LogEntry[] = [];
		this.logBlock(this.carry, batch);
		this.carry = '';
		if (batch.length > 0) {
			this.entriesEmitter.fire(batch);
		}
	}

	private pump(): void {
		if (this.pending) {
			return;
		}
		this.pending = true;
		const logPath = getEditorLogPath();
		fs.stat(logPath, (statErr, stats) => {
			if (statErr) {
				this.pending = false;
				return;
			}
			if (stats.size < this.offset) {
				// Unity truncated/replaced the log (new Editor session started).
				this.flushCarry();
				this.offset = 0;
			}
			if (stats.size === this.offset) {
				this.pending = false;
				return;
			}
			const start = this.offset;
			this.offset = stats.size;
			const stream = fs.createReadStream(logPath, { start, end: stats.size - 1, encoding: 'utf8' });
			let chunk = '';
			stream.on('data', (data) => (chunk += data));
			stream.on('close', () => {
				if (chunk) {
					this.emit(chunk);
				}
				this.pending = false;
			});
			stream.on('error', () => {
				this.pending = false;
			});
		});
	}
}
