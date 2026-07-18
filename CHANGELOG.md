# Changelog

## 0.2.0

- Replaced `fs.watch` with `chokidar` for `Editor.log` tailing — more reliable on Windows when the
  log file is truncated/replaced by a new Editor session.
- Fixed log updates arriving late/stalled during heavy `Editor.log` write bursts — `pump()` silently
  dropped a `change` event that arrived while a previous read was still in flight, so that portion
  of the log wasn't picked up until the *next* unrelated write happened to trigger another `change`
  event. `pump()` now queues one pending re-run instead of dropping it.
- Fixed a deeper cause of the same "not timely" symptom: `awaitWriteFinish` required 50ms with no
  file-size change before firing `change`, but Unity's write cadence under heavy logging is often
  faster than that, so the stability timer kept getting reset and updates could stall for seconds.
  Removed it — reads are already incremental byte-offset tailing, so there's no torn-read risk from
  firing on every write. Also switched to `usePolling` (100ms interval): confirmed via a burst-write
  test against the live 60MB+ log that native fs-event watching can coalesce or drop `change`
  notifications under a sustained rapid-write burst to one file, while polling reliably observes
  every growth step.
- Added click-to-jump support for compiler diagnostics (`Foo.cs(10,5): error CS0246: ...`), in
  addition to the existing runtime stack-frame format (`(at Foo.cs:42)`).
- Fixed log entries not appearing at all — the block-splitting regex only matched bare `\n\n`, but
  `Editor.log` uses CRLF, so blank-line separators never matched and everything stayed buffered.
- Replaced the `Editor.log` `OutputChannel` + TextMate-grammar viewer with a custom Webview panel
  (`Unity for Cursor: Show Unity Editor Log`). Two consecutive OutputChannel-based approaches
  (`LogOutputChannel` level tagging, then a custom TextMate grammar) both proved fundamentally
  unworkable — coloring wasn't visible/reliable, and Unity's own diagnostic suffix lines
  (`(Filename: Foo.cs Line: 42)`) were misclassified as standalone entries because they're
  separated from their parent message by a blank line. The webview now:
  - Renders each entry (message + stack trace) as one colored block by severity (red/yellow/default),
    built via safe DOM text nodes rather than `innerHTML` (log content isn't HTML-escaped).
  - Fixes the `(Filename: ... Line: ...)` marker bug by merging it into the preceding entry instead
    of treating it as a new one.
  - Keeps only the most recent 5000 entries (matching Rider/Unity Console's log-pruning behavior),
    avoiding unbounded DOM growth against 30-40MB+ logs.
  - Adds a toolbar: clear log, independent Error/Warning/Info filter toggles with live counts, and
    pause/resume auto-scroll (auto-pauses when the user scrolls up).
  - Reduces chokidar's `awaitWriteFinish` window (100ms/50ms → 50ms/20ms) to cut perceived latency.
  - Click-to-jump now goes through `postMessage` to the extension host instead of a
    `DocumentLinkProvider`/`command:` URI, reusing the existing `unityForCursor.openLogLocation`
    command unchanged.
  - Removes the now-unnecessary `unity-editor-log` TextMate grammar/language contribution and
    `syntaxes/` folder.
- Moved the log viewer from an editor-area `WebviewPanel` to a bottom-panel icon tab, docked
  alongside Terminal/Output/Debug Console (`contributes.viewsContainers.panel` +
  `contributes.views`, backed by `vscode.window.registerWebviewViewProvider`). It now stays
  persistently mounted instead of living as a closable editor tab, and
  `retainContextWhenHidden` is set on the view's `webviewOptions` so switching away and back
  doesn't re-render the whole entry list.
- Restructured each log entry from a single flat text block into a three-part list row: a
  level icon (⛔/⚠/ℹ), a formatted timestamp (`HH:mm:ss.SSS`, from the previously-unused
  `LogEntry.receivedAt`), and the message text — separated by a bottom border per row instead
  of the previous rounded, tinted block. Level icons were then changed to plain text labels
  (`Error`/`Warning`/`Info`) per feedback that the icon glyphs weren't clear enough.
- Reworked the log list into a Unity Console-style master/detail split: the list now shows one
  compact, ellipsized summary row per entry (level label + timestamp + first line only), and
  clicking a row shows its full multi-line text (with clickable file:line links) in a detail
  pane below. This fixes both the excessive row height of the old full-text-per-row layout and
  a real performance problem — hand-rolled list virtualization (fixed-height row pool, ~60
  recycled DOM nodes reused via absolute positioning + a spacer element, rAF-coalesced scroll
  handling) replaces full-list rendering, so the DOM node count stays constant instead of
  growing to 15,000+ at the 5000-entry cap, eliminating the reported jank when clicking/filtering
  near that limit. Also added a debounced (~150ms) substring search box that matches anywhere in
  an entry's full text (not just the summary line), combined with the existing level filters.
  A selected entry's detail stays visible even if a later filter/search excludes it from the
  list; it's only cleared when the entry itself is evicted from the ring buffer.
- Translated the remaining Chinese toolbar labels ("清空"/"自动滚动"/etc.) to English, and colored
  the Error/Warning level-filter toggle buttons to match their log-level color.
- Fixed a race where a pump already reading the old `Editor.log` (in flight when the file is
  deleted/replaced for a new Editor session) could apply its stale byte offset after the
  `unlink` handler had already reset state for the new session, corrupting the next read. A
  `generation` counter, captured at the start of each pump and rechecked after every async step,
  now detects and discards results from a pump that started against a since-replaced file.
- On extension activation/reload, stopped re-reading a pre-existing (possibly 60MB+) `Editor.log`
  from byte 0 only to immediately discard everything but the last 5000 entries via ring-buffer
  eviction. The very first read now seeks to within the last 8MB of the file instead, discarding
  the first (likely torn) block afterward.
- Fixed manually re-enabled breakpoints being auto-disabled again after a window reload. The
  auto-disabled tracking set was keyed on `vscode.Breakpoint.id`, which is an opaque per-session
  identifier with no guarantee of staying the same across a reload — so a fresh id after reload
  never matched the persisted set, and the breakpoint got disabled all over again even after the
  user had turned it back on. Now keyed on file URI + line number instead, which is stable across
  reloads.
- Fixed auto-reattach silently missing fast/optimized Domain Reloads. It used to only conclude a
  reload happened by observing the mono debugger's listening port go down and then back up across
  two separate 1-second polls — a sub-second Domain Reload can tear the socket down and recreate
  it entirely within a single poll interval, so both observations come back "listening" and the
  drop is never seen. Now compares the socket's own creation timestamp (`Get-NetTCPConnection`'s
  `CreationTime`) across polls instead: a Domain Reload always gives the recreated socket a new
  timestamp even if the port number is reused, so this catches reloads regardless of how fast they
  complete relative to the polling interval.
- Added a status bar message when auto-reattach's 25-second wait times out without detecting a
  reload, instead of failing silently — large projects can easily take longer than that to finish
  a Domain Reload, and the user previously had no indication auto-reattach had even been tried.
- Fixed PowerShell output potentially corrupting non-ASCII (e.g. Chinese) usernames/paths.
  `execFile` decodes PowerShell's stdout as UTF-8, but PowerShell itself writes to that pipe using
  the OS codepage unless told otherwise, so a Chinese path in `-projectpath` could come through
  mangled and silently break process-matching with no diagnostic indicating why. Now forces
  `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8` before every PowerShell command.
- Replaced the `Array.shift()`-based log entry eviction (both the extension host's buffer and the
  webview's mirrored copy) with a proper fixed-capacity ring buffer. `.shift()` is O(n) per
  eviction — a full memmove of the remaining ~5000 entries — turning every single steady-state
  append into O(n) work under the sustained write bursts this extension specifically targets;
  eviction is now O(1). Marker-line merging (`(Filename: ... Line: ...)`) also no longer needs to
  linearly search for the last entry by id — it holds a direct reference instead.
- Documented the breakpoint-filter glob matcher's actual capabilities and added `{a,b,c}` brace
  expansion support. Previously the supported subset (`*`, `**`, `?`) was undocumented, so a user
  writing `ignoreBreakpointsGlobs` with an unsupported pattern (e.g. `[abc]` character classes or
  `!negation`) would silently match nothing with no indication why; the config description and code
  comments now spell out exactly what's supported and what isn't.
- Replaced the shared module-level regexes' manual `lastIndex` reset with `String.prototype.matchAll`
  in `scanLinks()`. The previous `exec()` loop only worked correctly because the function always ran
  to exhaustion synchronously before returning — `matchAll` clones the regex internally instead of
  mutating the shared object's `lastIndex`, removing that fragile invariant.
- `EditorLogTailer.getSnapshot()` now returns `ReadonlyArray<Readonly<LogEntry>>` instead of a plain
  mutable array of mutable objects. The array itself was already a fresh copy, but the `LogEntry`
  objects inside it were the same live objects backing the ring buffer — a caller mutating a field
  in place (e.g. `entry.text = ...`) would have silently corrupted the tailer's internal state with
  no compiler warning.
- `resolveDebugCandidates()` now resolves each matched Unity process's listening ports concurrently
  via `Promise.all` instead of sequentially in a loop. Each lookup spawns its own `powershell.exe`
  process, so awaiting them one at a time paid that startup cost serially once per matched Unity
  instance when multiple projects/instances are running.
- Added three IDE-side features aimed at closing gaps with Rider's built-in Unity support, all built
  on the existing `EditorLogTailer` rather than opening new file watchers:
  - A status bar item shows a spinner while Unity is compiling/reloading the domain. Compile
    start/end are detected from `Editor.log` marker strings (`Begin MonoManager ReloadAssembly` /
    `Domain Reload Profiling:` / `Loaded All Assemblies`) empirically observed on this machine —
    not a documented Unity API, so a 120-second safety timeout force-clears the indicator in case a
    different Editor version's log phrasing doesn't match.
  - `Unity for Cursor: Find Usages in Scenes/Prefabs` (also available via right-click on a `.cs`
    file) finds which `.unity`/`.prefab` files reference the selected script, matched via the
    script's `.meta` GUID. Uses plain substring/regex matching rather than a real YAML parser,
    since Unity's GUID references are simple single-line mappings and Unity's YAML dialect isn't
    fully standard-compliant anyway. Note: this only finds scripts serialized directly onto a
    GameObject in the prefab/scene — a script attached at runtime via `AddComponent<T>()` (a
    pattern this codebase's `ViewController<T>` uses) has no GUID reference baked into the asset
    and won't be found this way. Also fixed the scan silently returning zero matches on projects
    (like this one) whose `.vscode/settings.json` sets `files.exclude` on `**/*.prefab`/`**/*.unity`
    to declutter the Explorer — `vscode.workspace.findFiles` applies `files.exclude` on top of any
    string `exclude` argument, so passing one there was quietly hiding every candidate before the
    scan started. The exclude argument is now `null` (bypasses `files.exclude` entirely), with the
    Library/Temp exclusion done as a manual path filter instead.
  - Find Usages is also now surfaced directly as a hover: hovering a script's class declaration
    (only fires when the class name matches the file name, per Unity's own naming requirement for
    a script's main class) shows a clickable "Find Usages in Scenes/Prefabs" button that runs the
    exact same command (progress notification, QuickPick, jump-to-location) — the hover itself
    doesn't scan or list matches, it just offers one-click access to the existing command. The
    per-GUID result cache (invalidated on any `.unity`/`.prefab` file change) is still shared with
    the command's own repeat invocations, since hover fires on every mouse-rest but the underlying
    scan is only ever triggered by an actual click. Fixed the hover's button doing nothing on
    click: a markdown `command:` URI round-trips its argument through JSON, so the command
    received a plain string instead of the `vscode.Uri` the right-click menu passes, and
    `.fsPath` on a string threw silently. The command now accepts either.
  - Hovering a Unity lifecycle method (`Awake`, `Update`, `OnTriggerEnter2D`, etc.) inside a class
    that directly inherits a known Unity base type (`MonoBehaviour`/`Editor`/`EditorWindow`/
    `ScriptableObject`) shows a short description of when Unity calls it. This is a syntactic
    heuristic, not real type analysis — it won't recognize a custom intermediate base class.
  - All toggleable features are gated behind new `unityForCursor.enableCompileStatusBar` /
    `enableLifecycleHover` / `enableSceneUsagesHover` settings (default `true`) so any can be turned
    off individually (e.g. if a hover visually conflicts with ReSharper's own hover).

## 0.1.0

- Registered a dedicated `unity-for-cursor-attach` debugger type so **Unity for Cursor** appears
  as a top-level entry in the "Select debugger" / Run and Debug picker, instead of being nested
  under ReSharper's "More Mono options...".
- Removed the pre-attach port verification probe. Unity's embedded mono debugger agent
  (`server=y,suspend=n`) only ever services a single incoming connection per Editor session, so a
  verification handshake before the real attach permanently consumed that slot and made every
  subsequent attach fail. Port selection is now based purely on OS-level listening-port
  information.
- Added real-time `Editor.log` streaming into an output channel, with clickable
  `(at File.cs:42)` stack frames that jump straight to the script and line
  (`Unity for Cursor: Show Unity Editor Log`).
- Added `unityForCursor.ignoreBreakpointsGlobs` to auto-disable newly added breakpoints under
  configured paths (defaults to `Library/` and `Packages/`), without re-disabling breakpoints a
  user manually re-enables afterward.
- Added automatic re-attach after a script recompile / Domain Reload, scoped to sessions that
  were already attached — detected by watching the Unity process's debug port disappear and
  reappear, which only happens on a genuine Domain Reload (a manual disconnect leaves the port
  listening).
- Added an extension icon.
- Reorganized `src/` into feature folders (`attach/`, `log/`, `breakpoints/`) and added a
  `.vscodeignore` so the packaged `.vsix` ships only runtime files.

## 0.0.1

- Initial release: discover a running Unity Editor process matching the open workspace and
  attach JetBrains "C# by ReSharper"'s `mono` debugger to it.
