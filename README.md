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

Microsoft's own path for Unity debugging in VS Code is the **C# Dev Kit** + **Unity**
([Visual Studio Tools for Unity](https://marketplace.visualstudio.com/items?itemName=VisualStudioToolsForUnity.vstuc))
extension pair, backed by Microsoft's `coreclr` debug engine. This project is for teams that
already use, or prefer, JetBrains' ReSharper tooling and want that same debugging workflow without
leaving Cursor — it does not replace or compete with the Dev Kit path, it targets a different
toolchain.

| Capability | Unity for Cursor + ReSharper | C# Dev Kit + Unity (VSTUC) |
|---|---|---|
| Attach entry point | Top-level **"Unity for Cursor"** entry in Run and Debug | Top-level **"Unity"** entry |
| Debug engine | JetBrains' `mono` debugger | Microsoft's `coreclr` debugger |
| Editor process discovery | Automatic (matches `-projectpath` against open workspace) | Automatic |
| Ignore breakpoints by path | Yes — `unityForCursor.ignoreBreakpointsGlobs` | Not exposed |
| Auto re-attach after Domain Reload | Yes, for sessions that were already attached | Not verified |
| `Editor.log` streaming with click-to-file | Yes | Not exposed |
| License requirement | Requires a JetBrains ReSharper license | Free |

The VSTUC column reflects its published manifest and documentation, not exhaustive end-to-end
testing of every workflow — treat it as a directional comparison, not a certified benchmark.

## Features

- **Top-level attach entry.** Registers its own `unity-for-cursor-attach` debugger type so "Unity
  for Cursor" shows up directly in the "Select debugger" picker, instead of being nested under
  "More ReSharper: Mono options...".
- **Automatic Editor discovery.** Matches running `Unity.exe` processes against the open
  workspace by `-projectpath`, and resolves the debug port from OS-level listening-port
  information — see [How port discovery works](#how-port-discovery-works) for why it deliberately
  avoids a live connection probe.
- **`Editor.log` streaming with click-to-file.** `Unity for Cursor: Show Unity Editor Log` tails
  the local `Editor.log` into an output channel in real time; stack frames like
  `(at Assets/Scripts/Foo.cs:42)` become clickable links that jump to the exact file and line.
- **Ignore breakpoints by path.** The `unityForCursor.ignoreBreakpointsGlobs` setting
  auto-disables newly added breakpoints under matching paths (defaults to `Library/` and
  `Packages/`); manually re-enabling one afterward is left alone.
- **Auto re-attach after Domain Reload.** Scoped to sessions that were already attached: a script
  recompile drops the debugger connection, and this extension detects the difference between that
  and a manual disconnect by watching whether the Unity process's debug port actually disappears
  and reappears, then re-attaches automatically.
- **Exception breakpoints** work out of the box — ReSharper's `mono` adapter implements this
  natively, so once attached you'll see the usual exception filter checkboxes in the Run and
  Debug view's Breakpoints panel.

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

Unity's documented convention is `56000 + (Editor PID % 1000)`, but in practice that port is
often not the one actually in use — even with Editor Attaching enabled, the port can shift if it's
already taken. So this extension:

- Uses `Get-CimInstance Win32_Process` to find local `Unity.exe` processes, matching the
  (lowercase) `-projectpath` argument against the open workspace.
- Uses `Get-NetTCPConnection -OwningProcess <pid> -State Listen` to list the ports that process is
  actually listening on.
- Attaches directly if there's exactly one matching process and the formula port is among its
  listening ports; otherwise prompts with a picker (formula-port matches are labeled).

**It deliberately never opens a real connection to a candidate port to verify it first.** Unity's
embedded mono debugger agent (`server=y,suspend=n`) only services a single incoming connection per
Editor session — an early version of this extension did a handshake-based verification probe
before attaching, and that probe itself consumed the one-shot connection slot, making the real
attach that followed fail every time with a handshake timeout. Port selection is therefore based
purely on OS-level listening-port information.

If no listening port matches (including the formula port), check Unity's **Editor Attaching**
preference and whether a firewall is blocking the 56000–59999 range. With multiple Unity windows
open on different projects, `-projectpath` disambiguates automatically; use the picker to choose
manually if it still guesses wrong.

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
