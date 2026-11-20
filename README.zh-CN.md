# Unity for Cursor

English documentation is available in `README.md` in the same directory.

在 Cursor（或任意兼容 VS Code 的编辑器）中，直接使用 JetBrains **"C# by ReSharper"** 的调试器 attach 到正在运行的
Unity Editor 进程，并提供一系列旨在拉近与 JetBrains Rider 内置 Unity 支持之间差距的增强功能。

本插件本身不实现调试器。它负责发现与当前工作区匹配的 Unity Editor 进程、解析其调试端口，并通过
`vscode.debug.startDebugging` 将结果交给 ReSharper 已有的 `mono` 调试适配器。除此之外的能力——日志流、断点过滤、
调试服务预检——均为本插件自行实现。支持 Windows、macOS 与 Linux。

## 为什么会有这个插件

Cursor 无法使用微软的 **C# Dev Kit** ——其授权协议限制只能在微软自家的 VS Code 和 Visual Studio 中使用，因此官方的
"C# Dev Kit + Unity" 调试方案在 Cursor 里根本不可用。
**FUCK Microsoft**

## 功能特性

- **调试** —— 支持断点（含异常断点），可以对 Unity Editor 中运行的 C# 代码单步调试。
- **自动发现 Editor 进程** —— 无需手动填端口，原理见下方[端口发现原理](#端口发现原理)。
- **`Editor.log` 实时流 + 点击跳转** —— `Unity for Cursor: Show Unity Editor Log` 命令实时输出日志，形如
  `(at Foo.cs:42)` 的堆栈行可直接点击跳转到对应文件和行号。
- **按路径忽略断点** —— `unityForCursor.ignoreBreakpointsGlobs` 会自动禁用匹配路径下新增的断点（默认匹配
  `Library/` 与 `Packages/`）。
- **Domain Reload 不断开** —— 调试会话在脚本重新编译后保持连接，断点自动在新域中重新生效，无需重新 attach。
- **attach 前预检** —— Unity 调试服务失效或已被其他调试器占用时，1.5 秒内给出明确提示，而不是卡到超时。

## 前置依赖

1. **"C# by ReSharper"**（`JetBrains.resharper-code`）—— 提供实际的 `mono` 调试引擎。已声明为
   `extensionDependencies`，若激活时检测到未安装，会弹出提示并提供一键安装。需要有效的 JetBrains 授权。
2. **禁用其他 C# 调试插件**（例如 C# Dev Kit）—— VS Code/Cursor 同一时间只允许一个插件持有 C# 调试引擎，更改后需要
   重新加载窗口。
3. Unity 的 **Script Debugging / Editor Attaching** 选项必须开启（默认开启）。

## 下载

已经打包好的 `.vsix` 发布在
[Releases 页面](https://github.com/Airuxul/unity-for-cursor/releases)，不需要自己从源码构建。每次向
`master` 推送代码后，[Actions 标签页](https://github.com/Airuxul/unity-for-cursor/actions) 下也会自动
产出一份构建产物，如果想拿最新的开发中版本可以从那里下载。

## 从源码构建

```powershell
cd tools/unity-for-cursor
npm install
npm run compile
npm run package   # 生成 unity-for-cursor-<version>.vsix
```

## 安装

- 命令面板 → `Extensions: Install from VSIX...` → 选择 `.vsix`；或
- 若 `cursor` CLI 已在 `PATH` 中：`cursor --install-extension unity-for-cursor-<version>.vsix`。

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

Unity 官方文档给出的端口公式 `56000 + (Editor PID % 1000)` 并不总是实际在用的端口。本插件通过 `-projectpath`
参数匹配运行中的 Unity Editor 进程与当前工作区（Unity 工程可以是工作区本身或其子目录），排除带 `-batchMode` 的
AssetImportWorker 子进程（它们也各自开着调试端口），再读取该进程实际监听的端口来确定调试端口。

进程与端口的查询按平台实现（`src/platform/`）：Windows 使用 PowerShell，macOS / Linux 使用 `ps` + `lsof`。

### 调试服务预检

真正 attach 之前，插件会对端口做一次"握手 + `VM_DISPOSE`"预检。实测（Unity 2022.3 / mono 6.13）结论：

- 发送 `VM_DISPOSE` 后再断开，调试服务立即可以接受下一次连接，所以预检不会占用连接。
- **不发 `VM_DISPOSE` 直接断开**（调试器崩溃、被强杀、attach 中途取消）会让 Unity 调试服务永久失效：端口仍在
  监听但不再响应握手，Domain Reload 也无法恢复，只能重启 Unity。
- 调试服务同一时间只服务一个调试器，已被 Rider / 其他窗口连接时也表现为不响应。

预检在这两种情况下会立即提示，而不是让 ReSharper 一直等待到超时。

### Package 代码的断点

Unity 为 `Packages/`、`Library/PackageCache/` 下的代码记录的是相对工程根目录的路径（`./Packages/...`），
插件会传入 `sourceFileMap` 把它映射到工程根目录，否则这些文件里的断点永远不会生效。

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
    unityProcess.ts          匹配当前工程的 Unity Editor 进程（与平台无关）
    agentProbe.ts            attach 前的调试服务预检
  platform/
    types.ts                 平台适配接口 PlatformAdapter
    index.ts                 按 process.platform 选择实现（新增平台只需在此加一个分支）
    windows.ts               Windows：PowerShell
    posix.ts                 macOS / Linux：ps + lsof
    exec.ts                  子进程执行工具
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
