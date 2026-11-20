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
- **Player/设备 attach** —— 同时发现局域网内广播的 Player/设备实例，可与本机 Editor 一起选择 attach。需要同时
  调试多个目标（例如 Editor + 一个 Player）时，再次运行 attach 命令并选择另一个目标即可——和 Rider 自己的
  "Attach to Unity Process" 流程一致。
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

## 测试

```powershell
npm test   # 先编译，再在一个真实下载的 VS Code 实例中运行测试
```

测试代码位于 `src/test/`（基于 `@vscode/test-cli` + `@vscode/test-electron` + Mocha）。首次运行会下载一份固定版本的
VS Code 到 `.vscode-test/`（已加入 `.gitignore`，且不会被打包进 `.vsix`）。


## 安装

- 命令面板 → `Extensions: Install from VSIX...` → 选择 `.vsix`；或
- 若 `cursor` CLI 已在 `PATH` 中：`cursor --install-extension unity-for-cursor-<version>.vsix`。

## 使用方法

1. 在 Cursor 中打开 Unity 项目根目录（即包含 `Assets`/`ProjectSettings` 的文件夹）。
2. 在同一个项目上启动 Unity Editor。
3. 在某个 `.cs` 脚本中打上断点。
4. 触发 attach，二选一：
   - **命令面板** → 运行 **"Attach to Unity (Editor/Player)..."**。
   - **Run and Debug 面板** → "Select debugger" → **"Unity for Cursor"**。
   如果发现了多个目标（本机 Editor 加上局域网内广播的任意 Player/设备），会弹出一个 QuickPick 让你选择其中
   一个 attach。需要同时 attach 多个目标时，针对每个目标再运行一次该命令即可。
5. 进入 Play Mode，确认断点被命中。

## 配置项

| 配置 | 默认值 | 说明 |
|---|---|---|
| `unityForCursor.ignoreBreakpointsGlobs` | `["**/Library/**", "**/Packages/**"]` | 匹配到这些 glob 的脚本文件中，新增的断点会被自动禁用（手动重新启用后不会被再次禁用）。 |

## 命令

| 命令 | 说明 |
|---|---|
| `Unity for Cursor: Attach to Unity (Editor/Player)...` | 发现本机 Editor 进程和局域网内广播的 Player，选择一个 attach；需要同时 attach 多个目标时再次运行该命令。 |
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

Player/设备目标的发现方式不同：Unity 的 Player Connection 协议下，每个可调试的实例大约每秒通过 UDP 组播
（`225.0.0.222`，配合几个固定端口）重新广播一次自身信息，调试用的 TCP 端口内嵌在广播消息的 `[Id]` 字段中。
这不是一份有正式文档保证稳定的公开 API，因此和 Editor 的公式端口猜测一样，属于尽力而为的启发式实现，不作
稳定性保证。

## 已知限制 / 后续规划

以下功能目前刻意未实现：

- **Attach and Wait** —— 让 Editor/Player 在启动时挂起、等待调试器连接后再继续执行（对应 Unity 的
  `-waitForManagedDebugger` 系列选项），目前未接入；只能在 Editor/Player 已经运行起来之后再 attach。

## 项目结构

```text
src/
  extension.ts              入口文件——串联所有功能模块
  attach/
    attach.ts                目标发现/选择 + 调试配置 Provider
    attachTarget.ts          Editor / Player attach 目标类型
    unityProcess.ts          匹配当前工程的 Unity Editor 进程（与平台无关）
    discoverPlayers.ts       局域网 Player/设备发现（基于 UDP 组播）
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
  hover/
    lifecycleHover.ts          Unity 生命周期方法 hover 提示
  analysis/
    csharpSymbols.ts           共享的 DocumentSymbol/TypeHierarchy 辅助函数（ReSharper 语义查询）
  test/
    extension.test.ts          激活冒烟测试
    analysis/csharpSymbols.test.ts  共享分析辅助函数的单元测试
resources/
  icon.png                    插件图标
```

## 开发说明

本插件是内部工具，未发布到公开的插件市场——`vsce package` 会提示缺少 `repository` 字段和 license 文件，这是预期
之内的，在正式对外发布之前会保持现状，不会为了消除警告而虚构许可证或仓库信息。
