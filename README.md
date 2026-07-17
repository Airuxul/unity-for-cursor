# Unity for Cursor

中文文档见同目录下的 `README.zh-CN.md`。

Attach JetBrains **"C# by ReSharper"**'s debugger to a running Unity Editor process, directly
from Cursor (or any VS Code–compatible editor) — plus a set of quality-of-life features aimed at
closing the gap with JetBrains Rider's built-in Unity support.

This extension does not implement a debugger itself. It discovers the Unity Editor process that
matches the open workspace, resolves its debug port, and hands the result to ReSharper's existing
`mono` debug adapter via `vscode.debug.startDebugging`. Everything on top of that — log
streaming, breakpoint filtering, auto re-attach — is this extension's own code.

## Why this exists

Cursor can't use Microsoft's **C# Dev Kit** — its license restricts it to Microsoft's own VS Code
and Visual Studio, so the official "C# Dev Kit + Unity" debugging path simply isn't available
here.
**FUCK Microsoft**

## Features

- **Debugging** — set breakpoints (including exception breakpoints) and step through C# code
  running in the Unity Editor.
- **Automatic Editor discovery** — no manual port entry; see
  [How port discovery works](#how-port-discovery-works).
- **`Editor.log` streaming with click-to-file** — `Unity for Cursor: Show Unity Editor Log` tails
  the log live, and stack frames like `(at Foo.cs:42)` jump straight to the file and line.
- **Ignore breakpoints by path** — `unityForCursor.ignoreBreakpointsGlobs` auto-disables new
  breakpoints under matching paths (defaults to `Library/` and `Packages/`).
- **Auto re-attach after Domain Reload** — for sessions that were already attached, a script
  recompile no longer requires attaching again by hand.

## Requirements

1. **"C# by ReSharper"** (`JetBrains.resharper-code`) — provides the actual `mono` debug engine.
   Declared as an `extensionDependencies` entry, with a runtime fallback prompt on activation if
   it isn't installed. Requires a valid JetBrains license.
2. **Disable other C# debug extensions** (e.g. C# Dev Kit) — VS Code/Cursor only allows one
   extension to own the C# debug engine at a time. Reload the window after changing this.
3. Unity's **Script Debugging / Editor Attaching** preference must be enabled (on by default).

## Build

```powershell
cd tools/unity-for-cursor
npm install
npm run compile
npm run package   # produces unity-for-cursor-<version>.vsix
```

## Install

- Command Palette → `Extensions: Install from VSIX...` → pick the generated `.vsix`; or
- `cursor --install-extension unity-for-cursor-<version>.vsix` if the `cursor` CLI is on `PATH`.

> When upgrading an already-installed copy, fully uninstall the old one from the Extensions view
> first rather than reinstalling over the same version — some VS Code–based IDEs cache extension
> metadata (including the icon) per version and won't pick up in-place changes otherwise.

## Usage

1. Open the Unity project root in Cursor (the folder containing `Assets`/`ProjectSettings`).
2. Start the Unity Editor on the same project.
3. Set a breakpoint in a `.cs` script.
4. Trigger attach, either way:
   - **Command Palette** → run **"Attach to Unity Editor"**.
   - **Run and Debug panel** → "Select debugger" → **"Unity for Cursor"**.
5. Enter Play Mode and confirm the breakpoint is hit.

## Configuration

| Setting | Default | Description |
|---|---|---|
| `unityForCursor.ignoreBreakpointsGlobs` | `["**/Library/**", "**/Packages/**"]` | Glob patterns; newly added breakpoints under matching paths are auto-disabled. |

## Commands

| Command | Description |
|---|---|
| `Unity for Cursor: Attach to Unity Editor` | Discover and attach to the local Unity Editor process. |
| `Unity for Cursor: Show Unity Editor Log` | Open the live-tailed `Editor.log` output channel. |

## How port discovery works

Unity's documented port formula (`56000 + Editor PID % 1000`) isn't always the port actually in
use. This extension instead matches running `Unity.exe` processes to the open workspace by
`-projectpath`, then reads the OS-level listening ports for that process to pick the right one —
it deliberately never opens a probe connection first, since Unity's embedded debugger only accepts
one incoming connection per Editor session, and a verification probe would consume that slot
before the real attach gets a chance.

## Known limitations / roadmap

Deliberately out of scope for now:

- **Multi-target attach** — attaching to a remote Player/device is a different discovery protocol
  (Unity broadcasts over UDP multicast, e.g. `225.0.0.222:54997`, with the debug port embedded in
  the `[Id]` field of the announcement message). Not implemented; would need a `dgram`-based
  listener alongside `unityProcess.ts`, reusing the same `attach.ts` orchestration.
- **Attach and Wait** — suspending the Editor/Player at startup until a debugger connects (Unity's
  `-waitForManagedDebugger` family of options) is not wired up; you can only attach after the
  Editor is already running.

## Project structure

```text
src/
  extension.ts              entry point — wires everything together
  attach/
    attach.ts                port resolution + debug configuration provider
    unityProcess.ts          Unity process/port discovery (PowerShell-backed)
    reattach.ts               Domain Reload auto re-attach
  log/
    editorLog.ts              Editor.log tailing + click-to-file links
  breakpoints/
    breakpointFilter.ts        ignore-by-glob breakpoint auto-disable
resources/
  icon.png                    extension icon
```

## Development notes

This is an internal tool, not published to a public marketplace — `vsce package` will warn about
a missing `repository` field and license file; both are expected and intentionally left as-is
until/unless this gets published externally.
