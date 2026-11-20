# Unity for Cursor

[中文](README.zh-CN.md)

Attach JetBrains **"C# by ReSharper"**'s debugger to a running Unity Editor process, directly
from Cursor (or any VS Code–compatible editor) — plus a set of quality-of-life features aimed at
closing the gap with JetBrains Rider's built-in Unity support.

This extension does not implement a debugger itself. It discovers the Unity Editor process that
matches the open workspace, resolves its debug port, and hands the result to ReSharper's existing
`mono` debug adapter via `vscode.debug.startDebugging`. Everything on top of that — log
streaming, breakpoint filtering, the debugger-agent pre-check — is this extension's own code.
Works on Windows, macOS and Linux.

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
- **Survives Domain Reload** — the debug session stays connected across script recompiles and
  breakpoints re-bind in the new domain; no re-attach needed.
- **Pre-attach check** — if Unity's debugger agent is wedged or already taken by another debugger,
  you get a clear message within 1.5s instead of a hang until timeout.

## Requirements

1. **"C# by ReSharper"** (`JetBrains.resharper-code`) — provides the actual `mono` debug engine.
   Declared as an `extensionDependencies` entry, with a runtime fallback prompt on activation if
   it isn't installed. Requires a valid JetBrains license.
2. **Disable other C# debug extensions** (e.g. C# Dev Kit) — VS Code/Cursor only allows one
   extension to own the C# debug engine at a time. Reload the window after changing this.
3. Unity's **Script Debugging / Editor Attaching** preference must be enabled (on by default).

## Download

Prebuilt `.vsix` files are published on the
[Releases page](https://github.com/Airuxul/unity-for-cursor/releases) — no need to build from
source. Every push to `master` also produces a build artifact under the
[Actions tab](https://github.com/Airuxul/unity-for-cursor/actions) if you want the latest
in-progress build.

## Build from source

```powershell
cd tools/unity-for-cursor
npm install
npm run compile
npm run package   # produces unity-for-cursor-<version>.vsix
```

## Install

- Command Palette → `Extensions: Install from VSIX...` → pick the `.vsix`; or
- `cursor --install-extension unity-for-cursor-<version>.vsix` if the `cursor` CLI is on `PATH`.

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
use. This extension matches running Unity Editor processes to the open workspace by `-projectpath`
(the Unity project may be the workspace folder or a subfolder of it), skips `-batchMode`
AssetImportWorker children (each of which runs its own debugger port), then reads the OS-level
listening ports for that process.

Process and port lookups are per-platform (`src/platform/`): PowerShell on Windows, `ps` + `lsof`
on macOS / Linux.

### Debugger-agent pre-check

Before the real attach, the extension does a "handshake + `VM_DISPOSE`" probe. Measured against
Unity 2022.3 / mono 6.13:

- A client that sends `VM_DISPOSE` before closing leaves the agent ready for the next connection
  immediately, so the probe doesn't use up the slot.
- A client that closes **without** `VM_DISPOSE` (debugger crash, kill, cancelled attach) leaves the
  agent permanently unable to complete a handshake: the port still listens but never answers, and
  a Domain Reload doesn't recover it. Only restarting Unity does.
- The agent serves one debugger at a time, so one already attached (Rider, another window) looks
  the same.

The probe reports either case right away instead of letting ReSharper wait for its timeout.

### Breakpoints in package code

Unity records sequence-point paths for `Packages/` and `Library/PackageCache/` code relative to the
project root (`./Packages/...`). The extension passes a `sourceFileMap` that maps them onto the
project root; without it, breakpoints in those files never bind.

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
    unityProcess.ts          match Unity Editor processes to the workspace (platform-independent)
    agentProbe.ts            pre-attach debugger-agent check
  platform/
    types.ts                 PlatformAdapter interface
    index.ts                 picks the implementation by process.platform (add a new OS here)
    windows.ts               Windows: PowerShell
    posix.ts                 macOS / Linux: ps + lsof
    exec.ts                  child-process helper
  log/
    editorLog.ts              Editor.log tailing + click-to-file links
  breakpoints/
    breakpointFilter.ts        ignore-by-glob breakpoint auto-disable
resources/
  icon.png                    extension icon
```

## Releasing

Bump `"version"` in `package.json`, commit, then push a matching tag:

```powershell
git tag v0.1.0
git push origin v0.1.0
```

The `Release` workflow builds the `.vsix` and attaches it to a new GitHub Release automatically.

## Development notes

This is not published to the VS Code Marketplace by design — `vsce package` will warn about a
missing `repository` field and license file; both are expected and intentionally left as-is unless
that changes.
