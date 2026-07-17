# Unity for Cursor

English documentation is available in `README.md` in the same directory.

在 Cursor（或任意兼容 VS Code 的编辑器）中，直接使用 JetBrains **"C# by ReSharper"** 的调试器 attach 到正在运行的
Unity Editor 进程，并提供一系列旨在拉近与 JetBrains Rider 内置 Unity 支持之间差距的增强功能。

本插件本身不实现调试器。它负责发现与当前工作区匹配的 Unity Editor 进程、解析其调试端口，并通过
`vscode.debug.startDebugging` 将结果交给 ReSharper 已有的 `mono` 调试适配器。除此之外的能力——日志流、断点过滤、
自动重连——均为本插件自行实现。

## 为什么会有这个插件

Cursor 无法使用微软的 **C# Dev Kit**——其授权协议限制只能在微软自家的 VS Code 和 Visual Studio 中使用，因此官方的
"C# Dev Kit + Unity" 调试方案在 Cursor 里根本不可用。本插件的目标，是让 Cursor 里开发 Unity 的体验尽量接近 JetBrains
Rider 原生自带的水平，做法是改用 JetBrains **"C# by ReSharper"** 的调试器来 attach。

## 功能特性

- **调试** —— 支持断点（含异常断点），可以对 Unity Editor 中运行的 C# 代码单步调试。
- **自动发现 Editor 进程** —— 无需手动填端口，原理见下方[端口发现原理](#端口发现原理)。
- **`Editor.log` 实时流 + 点击跳转** —— `Unity for Cursor: Show Unity Editor Log` 命令实时输出日志，形如
  `(at Foo.cs:42)` 的堆栈行可直接点击跳转到对应文件和行号。
- **按路径忽略断点** —— `unityForCursor.ignoreBreakpointsGlobs` 会自动禁用匹配路径下新增的断点（默认匹配
  `Library/` 与 `Packages/`）。
- **Domain Reload 后自动重连** —— 对已处于 attach 状态的会话，脚本重新编译后不再需要手动重新 attach。

## 前置依赖

1. **"C# by ReSharper"**（`JetBrains.resharper-code`）—— 提供实际的 `mono` 调试引擎。已声明为
   `extensionDependencies`，若激活时检测到未安装，会弹出提示并提供一键安装。需要有效的 JetBrains 授权。
2. **禁用其他 C# 调试插件**（例如 C# Dev Kit）—— VS Code/Cursor 同一时间只允许一个插件持有 C# 调试引擎，更改后需要
   重新加载窗口。
3. Unity 的 **Script Debugging / Editor Attaching** 选项必须开启（默认开启）。

## 构建

```powershell
cd tools/unity-for-cursor
npm install
npm run compile
npm run package   # 生成 unity-for-cursor-<version>.vsix
```

## 安装

- 命令面板 → `Extensions: Install from VSIX...` → 选择生成的 `.vsix`；或
- 若 `cursor` CLI 已在 `PATH` 中：`cursor --install-extension unity-for-cursor-<version>.vsix`。

> 升级已安装的版本时，建议先在 Extensions 视图中彻底卸载旧版本，而不是直接用同一版本号覆盖安装——部分基于
> VS Code 的 IDE 会按"插件 ID + 版本号"缓存插件元数据（包括图标），版本号不变时未必会重新读取。

## 使用方法

1. 在 Cursor 中打开 Unity 项目根目录（即包含 `Assets`/`ProjectSettings` 的文件夹）。
2. 在同一个项目上启动 Unity Editor。
3. 在某个 `.cs` 脚本中打上断点。
4. 触发 attach，二选一：
   - **命令面板** → 运行 **"Attach to Unity Editor"**。
   - **Run and Debug 面板** → "Select debugger" → **"Unity for Cursor"**。
5. 进入 Play Mode，确认断点被命中。

## 配置项

| 配置 | 默认值 | 说明 |
|---|---|---|
| `unityForCursor.ignoreBreakpointsGlobs` | `["**/Library/**", "**/Packages/**"]` | 匹配到这些 glob 的脚本文件中，新增的断点会被自动禁用（手动重新启用后不会被再次禁用）。 |

## 命令

| 命令 | 说明 |
|---|---|
| `Unity for Cursor: Attach to Unity Editor` | 发现并 attach 到本机运行的 Unity Editor 进程。 |
| `Unity for Cursor: Show Unity Editor Log` | 打开实时输出 `Editor.log` 的 Output Channel。 |

## 端口发现原理

Unity 官方文档给出的端口公式 `56000 + (Editor PID % 1000)` 并不总是实际在用的端口。本插件改为通过
`-projectpath` 参数匹配运行中的 `Unity.exe` 进程与当前工作区，再读取该进程实际监听的端口来确定调试端口——
刻意不预先建立一次真实连接来验证候选端口，因为 Unity 内置的调试代理每个 Editor 会话只服务一次入站连接，
提前的验证连接会把这唯一的连接名额消耗掉，导致随后真正的 attach 失败。

## 已知限制 / 后续规划

以下功能目前刻意未实现：

- **多目标 attach** —— attach 到远程 Player/设备使用的是完全不同的发现协议（Unity 通过 UDP 组播广播，例如
  `225.0.0.222:54997`，调试端口内嵌在广播消息的 `[Id]` 字段中）。尚未实现；如需支持，需要在 `unityProcess.ts`
  之外新增一个基于 `dgram` 的监听器，并复用现有的 `attach.ts` 编排逻辑。
- **Attach and Wait** —— 让 Editor/Player 在启动时挂起、等待调试器连接后再继续执行（对应 Unity 的
  `-waitForManagedDebugger` 系列选项），目前未接入；只能在 Editor 已经运行起来之后再 attach。

## 项目结构

```text
src/
  extension.ts              入口文件——串联所有功能模块
  attach/
    attach.ts                端口解析 + 调试配置 Provider
    unityProcess.ts          Unity 进程/端口发现（基于 PowerShell）
    reattach.ts               Domain Reload 后的自动重连
  log/
    editorLog.ts              Editor.log 实时流 + 点击跳转链接
  breakpoints/
    breakpointFilter.ts        按 glob 忽略断点的自动禁用逻辑
resources/
  icon.png                    插件图标
```

## 开发说明

本插件是内部工具，未发布到公开的插件市场——`vsce package` 会提示缺少 `repository` 字段和 license 文件，这是预期
之内的，在正式对外发布之前会保持现状，不会为了消除警告而虚构许可证或仓库信息。
