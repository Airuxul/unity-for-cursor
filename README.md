# Unity for Cursor

在 Cursor 里把 [JetBrains "C# by ReSharper"](https://marketplace.cursorapi.com/items/?itemName=JetBrains.resharper-code) 插件已经内置的 `mono` 调试适配器，接到本机正在运行的 Unity Editor 上，从而实现 Cursor + ReSharper + Unity 的断点调试。

本扩展本身不实现调试器，只做一件事：**发现本机与当前工程匹配的 Unity Editor 进程 → 校验其调试端口 → 调用 `vscode.debug.startDebugging` 把 host/port 喂给 ReSharper 已注册的 `mono` 调试类型**。依赖关系已在 `package.json` 里通过 `extensionDependencies: ["JetBrains.resharper-code"]` 声明，Cursor 安装/启用本扩展时会据此校验 "C# by ReSharper" 是否已安装。

## 前置条件

1. "C# by ReSharper"（`JetBrains.resharper-code`）——本扩展依赖它提供 `mono` 调试引擎，无需手动预装：
   - `package.json` 里声明了 `extensionDependencies: ["JetBrains.resharper-code"]`，Cursor 从 Marketplace 解析安装本扩展时会一并拉取该依赖（前提是当前配置的 Marketplace/Gallery 里能查到它，Cursor 官方源已确认可查到）。
   - 由于本扩展是以 `.vsix` 侧载安装的，`extensionDependencies` 的自动安装行为不一定总会触发，因此额外加了一层运行时兜底：本扩展启动时（`onStartupFinished`）会检测 `JetBrains.resharper-code` 是否已安装，若没有则弹出提示，点击"现在安装"即调用 `workbench.extensions.installExtension` 从 Marketplace 装好。
2. **禁用/卸载其他 C# 调试扩展**（例如 C# Dev Kit）。VS Code/Cursor 同一时间只能有一个扩展注册为 C# 调试引擎，装了别的会导致 ReSharper 的调试器不生效（ReSharper 官方 readme 里的说明）。改动后需要 Reload Window。
3. Unity 的 Script Debugging / Editor Attaching 开着（Editor 默认开，如果 attach 失败可以去检查一下相关 Preferences）。

## 构建

```powershell
cd tools/cursor-unity-attach
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
   - **Run and Debug 面板**：点击运行/调试图标（或 `Ctrl+Shift+D`）→ 点击 "Select debugger" / 齿轮旁的下拉 → 列表里选 **"Unity for Cursor: Attach to Unity Editor"**（本扩展把它注册成了 `mono` 类型的动态调试配置，会和 "ReSharper: Launch .NET Project" 这些条目一起出现在同一个选择器里）。
5. 进 Play Mode，触发到断点所在代码，观察是否命中。

> 两种方式走的是同一套端口发现逻辑，选哪个纯看习惯。如果 Run and Debug 面板的选择器里没看到 "Unity for Cursor: Attach to Unity Editor"，先确认本扩展已启用（它在 Cursor 启动时就会注册这个动态配置），必要时 Reload Window 一次。

## 端口发现逻辑与已知的坑

Unity 官方约定 Editor 的调试端口是 `56000 + (Editor 进程 PID % 1000)`，但实测这个约定端口经常不是实际监听的端口（哪怕 Editor Attaching 已开启，端口也可能被占用后顺延），而且"某个端口处于监听状态"本身也不能证明它就是调试端口——Unity/Hub 在同一段位置还开着 licensing、Accelerator 等其它 IPC 端口。因此本扩展不再只靠"约定端口是否在监听列表里"这种弱信号，而是：

- 用 `Get-CimInstance Win32_Process` 找本机所有 `Unity.exe` 进程，按 `-projectpath` 参数（注意是小写）匹配当前打开的工程；
- 对匹配到的 PID，用 `Get-NetTCPConnection -OwningProcess <pid> -State Listen` 列出它实际监听的所有端口；
- 对每个监听端口发起真正的 Mono 软调试器握手（连接后发送 `DWP-Handshake`，服务端原样回一份才算数，参见 [Mono Soft Debugger Wire Format](https://www.mono-project.com/docs/advanced/runtime/docs/soft-debugger-wire-format/)），只有握手通过的端口才会被当成"调试端口"；
- 恰好一个端口通过握手就直接 attach；有多个或都没通过，会弹出选择列表，握手通过的标"已通过 Mono 调试协议握手校验"，其余的标"未通过握手校验，可能不是调试端口"，供手动选择兜底。

如果所有监听端口都没通过握手校验（包括约定端口）：go 到 Unity Preferences 确认 **Editor Attaching** 是否开启（这是最常见的原因——没开就完全不会有调试端口监听），以及 Windows 防火墙/其他安全软件有没有拦截 56000-59999 这个端口段。

多个 Unity Editor 窗口同时开着不同工程时，靠 `-projectpath` 参数区分；如果还是选错，用弹出的列表手动挑正确的 PID。

## 范围之外：远程 Player/真机调试

本扩展只覆盖"本机 Unity Editor"这一种场景。远程 Player/真机调试走的是另一套协议——Unity 会向 UDP 组播地址 `225.0.0.222:54997`（以及 `34997`/`57997`/`58997`）广播形如：

```text
[IP] <ip> [Port] <port> [Flags] <flags> [Guid] <guid> [EditorId] <editorId> [Version] <version> [Id] <name>(<host>)[:<port>] [Debug] 1 [PackageName] <name>
```

的消息，`[Id]` 字段里冒号后的数字就是实际调试端口（Player 有，Editor 通常没有）。如果之后要扩展支持远程调试，可以在 `unityProcess.ts` 旁边加一个基于 Node `dgram` 的组播监听模块，复用同样的 `attach.ts` 编排逻辑。这次没有实现。
