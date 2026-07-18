# Changelog

## Unreleased

- Replaced `fs.watch` with `chokidar` for `Editor.log` tailing — more reliable on Windows when the
  log file is truncated/replaced by a new Editor session.
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
