# Changelog

## Unreleased

- Replaced `fs.watch` with `chokidar` for `Editor.log` tailing — more reliable on Windows when the
  log file is truncated/replaced by a new Editor session.
- `Editor.log` output is now a `LogOutputChannel` with entries classified as error/warning/info, so
  the panel gets native coloring and a built-in log-level filter instead of one flat text stream.
- `DocumentLinkProvider` for the log now scans incrementally (only newly-appended text) instead of
  re-scanning the whole document on every update.
- Added click-to-jump support for compiler diagnostics (`Foo.cs(10,5): error CS0246: ...`), in
  addition to the existing runtime stack-frame format (`(at Foo.cs:42)`).

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
