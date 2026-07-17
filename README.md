# Unity for Cursor

在 Cursor 里把 [JetBrains "C# by ReSharper"](https://marketplace.cursorapi.com/items/?itemName=JetBrains.resharper-code) 插件已经内置的 `mono` 调试适配器，接到本机正在运行的 Unity Editor 上，从而实现 Cursor + ReSharper + Unity 的断点调试。

本扩展本身不实现调试器，核心只做一件事：**发现本机与当前工程匹配的 Unity Editor 进程 → 解析其调试端口 → 调用 `vscode.debug.startDebugging` 把 host/port 喂给 ReSharper 已注册的 `mono` 调试类型**，在此基础上再叠加几项贴近 Rider 体验的增强（Editor.log 输出、断点忽略、Domain Reload 自动重连，见下文）。依赖关系已在 `package.json` 里通过 `extensionDependencies: ["JetBrains.resharper-code"]` 声明，Cursor 安装/启用本扩展时会据此校验 "C# by ReSharper" 是否已安装。

## 前置条件

1. "C# by ReSharper"（`JetBrains.resharper-code`）——本扩展依赖它提供 `mono` 调试引擎，无需手动预装：
   - `package.json` 里声明了 `extensionDependencies: ["JetBrains.resharper-code"]`，Cursor 从 Marketplace 解析安装本扩展时会一并拉取该依赖（前提是当前配置的 Marketplace/Gallery 里能查到它，Cursor 官方源已确认可查到）。
   - 由于本扩展是以 `.vsix` 侧载安装的，`extensionDependencies` 的自动安装行为不一定总会触发，因此额外加了一层运行时兜底：本扩展启动时（`onStartupFinished`）会检测 `JetBrains.resharper-code` 是否已安装，若没有则弹出提示，点击"现在安装"即调用 `workbench.extensions.installExtension` 从 Marketplace 装好。
2. **禁用/卸载其他 C# 调试扩展**（例如 C# Dev Kit）。VS Code/Cursor 同一时间只能有一个扩展注册为 C# 调试引擎，装了别的会导致 ReSharper 的调试器不生效（ReSharper 官方 readme 里的说明）。改动后需要 Reload Window。
3. Unity 的 Script Debugging / Editor Attaching 开着（Editor 默认开，如果 attach 失败可以去检查一下相关 Preferences）。

## 构建

```powershell
cd tools/unity-for-cursor
npm install
npm run compile
npm run package   # 产出 unity-for-cursor-0.0.1.vsix
```

## 安装到 Cursor

- 命令面板 → `Extensions: Install from VSIX...` → 选中生成的 `.vsix`；
- 或者如果 `cursor` CLI 在 PATH 里：`cursor --install-extension unity-for-cursor-0.0.1.vsix`。

## 使用

1. 用 Cursor 打开 Unity 工程根目录（`Assets`/`ProjectSettings` 所在的那一层）。
2. 启动 Unity Editor 打开同一个工程。
3. 在某个 `.cs` 脚本里打断点。
4. 触发 attach，两种方式任选：
   - **命令面板**：`Ctrl+Shift+P` → 运行 **"Attach to Unity Editor"**。
   - **Run and Debug 面板**：点击运行/调试图标（或 `Ctrl+Shift+D`）→ "Select debugger" 列表最外层就有 **"Unity for Cursor"**（本扩展声明了自己独立的调试器类型 `unity-for-cursor-attach`，不再挂在 ReSharper 的 `mono` 类型下面），选中后会自动发现端口并把配置改写成真正的 `mono` 类型转交给 ReSharper 的调试适配器。
5. 进 Play Mode，触发到断点所在代码，观察是否命中。

> 两种方式走的是同一套端口发现逻辑，选哪个纯看习惯。如果 Run and Debug 面板的选择器里没看到 "Unity for Cursor"，先确认本扩展已启用，必要时 Reload Window 一次。

## 端口发现逻辑与已知的坑

Unity 官方约定 Editor 的调试端口是 `56000 + (Editor 进程 PID % 1000)`，但实测这个约定端口经常不是实际监听的端口（哪怕 Editor Attaching 已开启，端口也可能被占用后顺延）。本扩展的发现逻辑：

- 用 `Get-CimInstance Win32_Process` 找本机所有 `Unity.exe` 进程，按 `-projectpath` 参数（注意是小写）匹配当前打开的工程；
- 对匹配到的 PID，用 `Get-NetTCPConnection -OwningProcess <pid> -State Listen` 列出它实际监听的所有端口；
- 恰好一个候选进程、且约定端口在其监听列表里时直接 attach；否则弹出选择列表（约定端口命中的标"符合 Unity 约定端口公式"），供手动选择。

**重要：这里绝不会对候选端口发起真正的连接去校验它是不是调试端口。** Unity 内置的 Mono 软调试器（`server=y,suspend=n`）每个 Editor 会话只服务**一次**入站连接——早期实现里加过一个连接校验探测（DWP-Handshake），结果导致探测本身把这个"一次性连接名额"用掉了，后续 ReSharper 真正发起的 attach 反而必现 `SocketException (10060)` 超时失败。所以现在端口选择完全基于 OS 级别的监听端口信息，不做任何真实握手。

如果所有监听端口都不含约定端口、或压根没有监听端口：去 Unity Preferences 确认 **Editor Attaching** 是否开启（这是最常见的原因——没开就完全不会有调试端口监听），以及 Windows 防火墙/其他安全软件有没有拦截 56000-59999 这个端口段。

多个 Unity Editor 窗口同时开着不同工程时，靠 `-projectpath` 参数区分；如果还是选错，用弹出的列表手动挑正确的 PID。

## Editor.log 实时输出 + 点击跳转

命令面板运行 **"Unity for Cursor: Show Unity Editor Log"**，会打开一个名为 "Unity Editor Log" 的 Output Channel，实时 tail 本机的 `%LOCALAPPDATA%\Unity\Editor\Editor.log`（扩展激活时即已在后台开始监听文件变化，不需要先手动打开面板才开始收集）。Unity 重启导致日志被截断/替换时会自动从头重新开始输出。

日志里形如 `(at Assets/Scripts/Foo.cs:42)` 的堆栈帧会被识别成可点击链接，点击后按当前工作区根目录解析相对路径并跳转到对应脚本的对应行。

## 按配置忽略指定脚本文件的断点

配置项 `unityForCursor.ignoreBreakpointsGlobs`（默认 `["**/Library/**", "**/Packages/**"]`）：新增的断点如果匹配到这些 glob，会被自动禁用（而不是阻止创建），状态栏会提示禁用了几个。这只在断点**新增时**生效一次——如果之后手动把某个断点重新打开，扩展不会再次把它关掉，方便临时进到 Packages 里调试。

## Domain Reload 后自动重连

仅在**已经处于 attach 会话中**时生效：脚本重新编译触发 Domain Reload 会让 Mono 调试器连接掉线，扩展会在会话终止后观察 Unity 进程对应端口是否经历了"消失又重新出现"（这正是 Domain Reload 重启 Mono 运行时的特征，而用户手动点 Stop/Disconnect 并不会让监听端口消失），确认是 Domain Reload 而非用户主动断开后，自动重新 attach，无需手动再次触发。不处理"从零开始的自动 attach"（比如 Unity 刚启动、还没手动 attach 过一次的场景）。

## 异常断点

无需本扩展任何代码：ReSharper 的 `mono` 调试适配器本身就原生支持 DAP 的 `exceptionBreakpointFilters`（反编译其 `JetBrains.VsCode.Debugger.Worker.exe` 可以看到 `UnhandledExceptionsFilter`、`ExceptionBreakpointsFilter` 等内置类型）。attach 成功后，在 Run and Debug 面板的 Breakpoints 分组里就能看到并勾选相应的异常断点选项。

## TODO（暂不实现）

- **多目标 attach**：目前只支持本机唯一一个 Unity Editor 进程；attach 到真机/远程 Player（见下一节的组播发现协议）尚未做。
- **Attach and Wait**：Unity 支持在 Editor/Player 启动时先挂起等待调试器连上再继续执行（对应 Unity 的 `-waitForManagedDebugger` 等机制），目前未接入，只能在 Editor 已经跑起来之后再 attach。

## 范围之外：远程 Player/真机调试

本扩展只覆盖"本机 Unity Editor"这一种场景。远程 Player/真机调试走的是另一套协议——Unity 会向 UDP 组播地址 `225.0.0.222:54997`（以及 `34997`/`57997`/`58997`）广播形如：

```text
[IP] <ip> [Port] <port> [Flags] <flags> [Guid] <guid> [EditorId] <editorId> [Version] <version> [Id] <name>(<host>)[:<port>] [Debug] 1 [PackageName] <name>
```

的消息，`[Id]` 字段里冒号后的数字就是实际调试端口（Player 有，Editor 通常没有）。如果之后要扩展支持远程调试，可以在 `unityProcess.ts` 旁边加一个基于 Node `dgram` 的组播监听模块，复用同样的 `attach.ts` 编排逻辑。这次没有实现。
