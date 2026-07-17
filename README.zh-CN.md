# Unity for Cursor

English documentation is available in `README.md` in the same directory.

在 Cursor（或任意兼容 VS Code 的编辑器）中，直接使用 JetBrains **"C# by ReSharper"** 的调试器 attach 到正在运行的
Unity Editor 进程，并提供一系列旨在拉近与 JetBrains Rider 内置 Unity 支持之间差距的增强功能。

本插件本身不实现调试器。它负责发现与当前工作区匹配的 Unity Editor 进程、解析其调试端口，并通过
`vscode.debug.startDebugging` 将结果交给 ReSharper 已有的 `mono` 调试适配器。除此之外的能力——日志流、断点过滤、
自动重连——均为本插件自行实现。

## 为什么会有这个插件

微软官方在 VS Code 中调试 Unity 的路径是 **C# Dev Kit** + **Unity**
（[Visual Studio Tools for Unity](https://marketplace.visualstudio.com/items?itemName=VisualStudioToolsForUnity.vstuc)）
插件组合，底层使用微软的 `coreclr` 调试引擎。本项目面向已经在使用、或更倾向于使用 JetBrains ReSharper 工具链的团队，
希望在不离开 Cursor 的前提下获得同样的调试体验——它并不是要替代或竞争 Dev Kit 这条路径，而是服务于另一套工具链。

| 能力 | Unity for Cursor + ReSharper | C# Dev Kit + Unity (VSTUC) |
|---|---|---|
| Attach 入口 | Run and Debug 面板中的顶级入口 **"Unity for Cursor"** | 顶级入口 **"Unity"** |
| 调试引擎 | JetBrains 的 `mono` 调试器 | 微软的 `coreclr` 调试器 |
| Editor 进程发现 | 自动发现（通过 `-projectpath` 与当前工作区匹配） | 自动发现 |
| 按路径忽略断点 | 支持 —— `unityForCursor.ignoreBreakpointsGlobs` | 未提供 |
| Domain Reload 后自动重连 | 支持（限已处于 attach 状态的会话） | 未验证 |
| `Editor.log` 实时流 + 点击跳转 | 支持 | 未提供 |
| 许可要求 | 需要 JetBrains ReSharper 授权 | 免费 |

VSTUC 一列的信息来自其公开的插件清单与文档，并非对其所有工作流做过详尽的端到端测试——请将其视为方向性对比，
而非权威评测。

## 功能特性

- **顶级 Attach 入口。** 注册了独立的 `unity-for-cursor-attach` 调试器类型，使 "Unity for Cursor" 直接出现在
  "Select debugger" 选择器的顶层，而不是嵌套在 ReSharper 的 "More Mono options..." 之下。
- **自动发现 Editor 进程。** 通过匹配运行中的 `Unity.exe` 进程的 `-projectpath` 参数与当前工作区，并基于操作系统级
  的监听端口信息解析调试端口——具体原因见下方[端口发现原理](#端口发现原理)。
- **`Editor.log` 实时流 + 点击跳转。** `Unity for Cursor: Show Unity Editor Log` 命令会将本机的 `Editor.log`
  实时输出到一个 Output Channel 中；形如 `(at Assets/Scripts/Foo.cs:42)` 的堆栈行会变成可点击链接，直接跳转到对应
  文件和行号。
- **按路径忽略断点。** `unityForCursor.ignoreBreakpointsGlobs` 配置项会自动禁用匹配路径下新增的断点（默认匹配
  `Library/` 与 `Packages/`）；用户手动重新启用的断点不会被再次禁用。
- **Domain Reload 后自动重连。** 仅限于已经处于 attach 状态的会话：脚本重新编译会导致调试连接断开，本插件通过
  监测 Unity 进程的调试端口是否真的先消失、再重新出现，来区分"Domain Reload"与"手动断开连接"，并在确认是前者时
  自动重新 attach。
- **异常断点** 开箱即用——这是 ReSharper 的 `mono` 适配器原生支持的能力，attach 成功后即可在 Run and Debug 视图的
  Breakpoints 面板中看到常规的异常过滤复选框。

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

Unity 官方文档给出的约定是 `56000 + (Editor PID % 1000)`，但实践中这个端口经常并非实际使用的端口——即便开启了
Editor Attaching，如果该端口已被占用，实际监听端口也会发生偏移。因此本插件采用如下策略：

- 使用 `Get-CimInstance Win32_Process` 查找本机的 `Unity.exe` 进程，通过（小写化后的）`-projectpath` 参数与当前
  工作区匹配。
- 使用 `Get-NetTCPConnection -OwningProcess <pid> -State Listen` 列出该进程实际监听的端口。
- 若只匹配到唯一进程，且公式端口确实在其监听端口列表中，则直接 attach；否则弹出选择器（公式端口命中的选项会
  额外标注）。

**本插件刻意不会为了验证候选端口而预先建立一次真实连接。** Unity 内置的 mono 调试代理
（`server=y,suspend=n`）在每个 Editor 会话中只服务**一次**入站连接——本插件早期版本曾在正式 attach 前先做一次
握手验证，但那次验证本身就消耗掉了这唯一的连接名额，导致随后的真正 attach 每次都会因握手超时而失败。因此端口的
选定完全基于操作系统级的监听端口信息，不做任何连接层面的探测。

如果没有任何监听端口匹配（包括公式端口），请检查 Unity 的 **Editor Attaching** 选项是否开启，以及防火墙是否拦截了
56000–59999 端口范围。若同时打开了多个指向不同项目的 Unity 窗口，`-projectpath` 会自动区分；如果仍然匹配错误，
可以使用选择器手动指定。

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
