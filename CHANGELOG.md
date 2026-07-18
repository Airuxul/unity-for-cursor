# Changelog

## Unreleased

- Replaced `fs.watch` with `chokidar` for `Editor.log` tailing — more reliable on Windows when the
  log file is truncated/replaced by a new Editor session.
- `DocumentLinkProvider` for the log now scans incrementally (only newly-appended text) instead of
  re-scanning the whole document on every update.
- Added click-to-jump support for compiler diagnostics (`Foo.cs(10,5): error CS0246: ...`), in
  addition to the existing runtime stack-frame format (`(at Foo.cs:42)`).
- Fixed log entries not appearing at all — the block-splitting regex only matched bare `\n\n`, but
  `Editor.log` uses CRLF, so blank-line separators never matched and everything stayed buffered.
- Reworked `Editor.log` rendering: each log entry (message + stack trace) now prints as a single
  plain-text block prefixed with `⛔`/`⚠` for error/warning, followed by a blank separator line, and
  a custom TextMate grammar colors the *entire* block (not just the first line) red/yellow by
  severity. This replaces an earlier `LogOutputChannel`-based attempt, which turned out to be
  fundamentally unworkable: `LogOutputChannel` only colors the single string passed to
  `error()`/`warn()`/`info()`, and its `appendLine()` silently auto-tags every call as its own
  timestamped `[info]` line — there was no way to append plain continuation text or a blank
  separator without it becoming spammy fake log entries. The tradeoff is losing the panel's
  built-in Trace/Debug/Info/Warning/Error level-filter dropdown.

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
