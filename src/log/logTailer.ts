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
// Cap on how much of a pre-existing (possibly 60MB+) Editor.log we re-read on startup. Reading the
// whole file just to throw away everything except the last MAX_ENTRIES via ring-buffer eviction is
// pure wasted CPU; seeking near the end and reading only this much tail is enough to comfortably
// repopulate the buffer while keeping startup fast.
const INITIAL_TAIL_BYTES = 8 * 1024 * 1024;

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

	// matchAll clones the regex internally rather than advancing the shared module-level
	// object's `lastIndex` — safe even if this ever became reentrant/async, unlike the previous
	// exec()-loop-with-manual-lastIndex-reset, which only worked because scanLinks always ran to
	// exhaustion synchronously before returning (a fragile, easy-to-break invariant).
	for (const match of text.matchAll(STACK_FRAME_PATTERN)) {
		const [full, file, lineStr] = match;
		links.push({
			start: match.index,
			end: match.index + full.length,
			file,
			line: parseInt(lineStr, 10),
		});
	}

	for (const match of text.matchAll(COMPILER_DIAGNOSTIC_PATTERN)) {
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
	// Fixed-capacity ring buffer: `buffer[head]` is the oldest live entry, `size` live entries
	// are stored at `(head + i) % MAX_ENTRIES` for i in [0, size). Overwriting `buffer[head]` and
	// advancing `head` is O(1) eviction — unlike an `Array.shift()`-based buffer, which is O(n)
	// per eviction (a full memmove of the remaining ~5000 elements) and turns every single
	// steady-state append into O(n) work under a sustained write burst.
	private buffer: (LogEntry | undefined)[] = new Array(MAX_ENTRIES);
	private head = 0;
	private size = 0;
	private nextId = 1;
	// Direct reference to the most recently added entry, so marker-line merging (below) doesn't
	// need to search the buffer by id — that's no longer even possible in O(1) once storage is a
	// ring buffer rather than a plain ordered array.
	private lastEntry: LogEntry | undefined;
	private offset = 0;
	private pending = false;
	private pumpQueued = false;
	// Bumped whenever the log file is deleted/replaced (new Editor session). An in-flight pump
	// started against the old file must not apply its stale offset/entries after that happens —
	// checking this after each async step lets us detect and discard that stale work instead of
	// corrupting the new session's state.
	private generation = 0;
	private initialized = false;
	// Set when startup seeks partway into a large pre-existing log (see INITIAL_TAIL_BYTES); the
	// first block read afterward is likely a truncated fragment, not a real entry, and must be
	// dropped rather than misrendered as one.
	private trimNextBlock = false;
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
			// No awaitWriteFinish: Unity's write cadence during heavy logging is often faster than
			// any stability window, which would delay `change` events indefinitely. Reads stay
			// incremental (byte-offset tailing below), so a `change` firing mid-write just means
			// the next pump picks up the remaining bytes — no risk of reading torn data.
			// usePolling: native fs-event backends (ReadDirectoryChangesW on Windows) can coalesce
			// several rapid writes to one file into a single notification, or drop one entirely,
			// under a sustained burst — which is exactly the "not timely" symptom. Polling the
			// file's size/mtime on a fixed interval instead guarantees every growth step is
			// eventually observed, at the cost of a small constant poll overhead.
			this.watcher = chokidar.watch(getEditorLogPath(), {
				ignoreInitial: true,
				usePolling: true,
				interval: 100,
			});
			this.watcher
				.on('add', () => this.pump())
				.on('change', () => this.pump())
				.on('unlink', () => {
					// Unity typically renames the old log to Editor-prev.log rather than
					// truncating in place when a new session starts. A pump() may already be
					// in flight reading the old file; bumping `generation` lets it detect it's
					// now stale (checked after each async step below) instead of clobbering the
					// offset/carry we're about to reset here with data from the old file.
					this.generation++;
					this.flushCarry();
					this.offset = 0;
				});
		} catch {
			// Unity has never run on this machine — the log directory doesn't exist yet.
		}
		this.pump();
	}

	// The array itself is already a fresh copy (built below), so push/sort/etc. by a caller can't
	// corrupt internal state — but the entries within are the same objects backing the live ring
	// buffer, so the return type is Readonly to catch accidental in-place mutation (e.g.
	// `entry.text = ...`) at compile time; there was previously no type-level protection against
	// either.
	getSnapshot(): ReadonlyArray<Readonly<LogEntry>> {
		const result: LogEntry[] = new Array(this.size);
		for (let i = 0; i < this.size; i++) {
			result[i] = this.buffer[(this.head + i) % MAX_ENTRIES] as LogEntry;
		}
		return result;
	}

	clearBuffer(): void {
		this.buffer = new Array(MAX_ENTRIES);
		this.head = 0;
		this.size = 0;
		this.lastEntry = undefined;
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
		if (this.size < MAX_ENTRIES) {
			this.buffer[(this.head + this.size) % MAX_ENTRIES] = entry;
			this.size++;
		} else {
			// Full: overwrite the oldest slot in place and advance head past it — O(1), unlike
			// `Array.shift()` which would memmove the remaining ~5000 elements on every eviction.
			this.buffer[this.head] = entry;
			this.head = (this.head + 1) % MAX_ENTRIES;
		}
		this.lastEntry = entry;
		batch.push(entry);
	}

	private logBlock(block: string, batch: LogEntry[]): void {
		const trimmed = block.trim();
		if (!trimmed) {
			return;
		}
		if (FILENAME_MARKER_PATTERN.test(trimmed) && this.lastEntry !== undefined) {
			this.lastEntry.text += '\n' + trimmed;
			this.updateEmitter.fire({ id: this.lastEntry.id, appendText: trimmed });
			return;
		}
		this.addEntry(block, batch);
	}

	private emit(text: string): void {
		const combined = this.carry + text;
		const blocks = combined.split(/\r?\n\r?\n+/);
		this.carry = blocks.pop() ?? '';
		const batch: LogEntry[] = [];
		for (let i = 0; i < blocks.length; i++) {
			if (i === 0 && this.trimNextBlock) {
				// The very first block read after seeking into the middle of a large pre-existing
				// log is likely a fragment of a bigger block we started reading partway through —
				// discard it rather than misrendering a torn entry.
				this.trimNextBlock = false;
				continue;
			}
			this.logBlock(blocks[i], batch);
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
			// A change event arrived while a read was already in flight — don't drop it, since
			// the write that triggered it may not be covered by the in-flight read's stat size.
			this.pumpQueued = true;
			return;
		}
		this.pending = true;
		const generation = this.generation;
		const logPath = getEditorLogPath();
		fs.stat(logPath, (statErr, stats) => {
			if (generation !== this.generation) {
				// The log was deleted/replaced while this stat was in flight; the `unlink`
				// handler already reset offset/carry for the new session — applying this stale
				// result on top would clobber that reset with data from the old file.
				this.finishPump();
				return;
			}
			if (statErr) {
				this.finishPump();
				return;
			}
			if (!this.initialized) {
				this.initialized = true;
				if (stats.size > INITIAL_TAIL_BYTES) {
					// Skip straight to the last INITIAL_TAIL_BYTES instead of re-reading a
					// potentially 60MB+ pre-existing log from byte 0, only to immediately discard
					// all but the last MAX_ENTRIES via ring-buffer eviction.
					this.offset = stats.size - INITIAL_TAIL_BYTES;
					this.trimNextBlock = true;
				}
			}
			if (stats.size < this.offset) {
				// Unity truncated/replaced the log (new Editor session started).
				this.flushCarry();
				this.offset = 0;
			}
			if (stats.size === this.offset) {
				this.finishPump();
				return;
			}
			const start = this.offset;
			this.offset = stats.size;
			const stream = fs.createReadStream(logPath, { start, end: stats.size - 1, encoding: 'utf8' });
			let chunk = '';
			stream.on('data', (data) => (chunk += data));
			stream.on('close', () => {
				if (generation === this.generation && chunk) {
					this.emit(chunk);
				}
				this.finishPump();
			});
			stream.on('error', () => {
				this.finishPump();
			});
		});
	}

	private finishPump(): void {
		this.pending = false;
		if (this.pumpQueued) {
			this.pumpQueued = false;
			this.pump();
		}
	}
}
