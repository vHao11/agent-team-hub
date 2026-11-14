# Windows 快速开始

以下步骤从项目源码目录开始。默认监听本机 `127.0.0.1:8765`。演示模式和正式数据使用不同目录。

## 环境

- Python 3.11 或更新版本，能够使用 `python`；本次后端测试使用 Python 3.12.14。
- 构建 Web 或使用 CLI：Node.js 22 或更新版本，能够使用 `node` 与 `npm`。
- 使用 DSH 插件：Node.js 至少 24.9.0，支持 DSH `0.2.2-rc.1` 和 `0.2.2-rc.2`。两版已在隔离 Linux 宿主完成安装和工具调用验证，Windows 环境仍需实际执行验收。自动安装入口见 [安装到现有 DSH](dsh-installation.md)。
- 下载并解压完整项目源码。

在 PowerShell 中进入解压后的 `agent-team-hub` 目录。

## 启动演示

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start.ps1 -Demo
```

浏览器打开：

```text
http://127.0.0.1:8765
```

演示界面提供三种身份，分别用于请求、承接与测试组协作。演示令牌只用于显式演示模式和演示数据库，不用于真实团队部署。

需要指定目录或端口时：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start.ps1 -Demo -DataDir .\data-demo -Port 8765
```

脚本创建项目内 Python 环境，安装服务与 MCP 依赖；只有缺少 `web/dist/index.html` 时才安装并构建前端。源码交付已有预构建界面时，运行服务无需本机 Node。脚本默认数据目录为演示用的 `.teamhub-demo` 或正式用的 `.teamhub`。

首次启动需要获取依赖；若失败，保留控制台错误，修复网络或解释器问题后重试，不删除已有数据目录。修改前端源码后须主动重新运行构建命令。

## 手动安装与启动

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e ".[dev]"
npm --prefix web ci
npm --prefix web run build
.\.venv\Scripts\python.exe -m teamhub serve --data-dir .\data-demo --demo --port 8765
```

以上路径均相对项目根目录。无需改变用户的系统 Python 包或现有 DSH 安装。

## 初始化正式数据

使用一个新的数据目录初始化：

```powershell
.\.venv\Scripts\python.exe -m teamhub init --data-dir .\data-team
.\.venv\Scripts\python.exe -m teamhub serve --data-dir .\data-team --port 8765
```

初始化命令输出首次管理员令牌。在页面的「连接设置」中填写服务地址与该令牌，管理员随后可在「团队与成员」区域建立团队，并添加属于该团队的成员。添加成员后保存当次返回的个人令牌，交由该成员填写自己的连接设置。

后续启动复用同一数据目录，避免重复初始化造成身份混淆。演示目录不能直接切换成正式目录；正式空间使用独立初始化的数据。也可以直接运行 `scripts/start.ps1 -DataDir .\data-team`，脚本会在该目录尚无数据库时先执行正式初始化。

团队使用时将服务运行在成员可访问的主机上，并按启动参数配置监听地址；远程入口使用 HTTPS。不要直接把演示身份开放给真实团队使用。

## 运行测试

```powershell
.\.venv\Scripts\python.exe -m pytest tests -q
npm --prefix web run build
```

CLI、MCP 和 DSH 的完整命令参见 [接入说明](../packages/INTEGRATION.md)。MCP 连接需使用服务地址及成员令牌，不复用演示令牌到正式空间。

## 通用 CLI 与 MCP

CLI 可供支持终端命令的 harness 使用：

```powershell
node .\packages\cli\build.mjs
node .\packages\cli\bin\teamhub.mjs --help
```

MCP 是可选依赖，先安装该扩展，再使用项目的 Python 环境以 stdio 方式供客户端启动。对应配置为：

```powershell
.\.venv\Scripts\python.exe -m pip install -e ".[mcp]"
$env:TEAMHUB_URL = "http://127.0.0.1:8765"
$env:TEAMHUB_TOKEN = "替换为本人的成员令牌"
.\.venv\Scripts\python.exe -m teamhub.mcp_server
```

stdio 服务启动后等待 MCP 客户端消息，不会显示普通交互菜单。在 harness 的 MCP 配置中填写同一解释器路径、`-m teamhub.mcp_server` 参数及这两个环境变量即可。

## DSH 接入

新插件包负责台账接口与宿主适配。安装前确认当前 DSH 版本和 profile，按照包内说明构建和安装。真实个人看板、增强 Superagent 的自动接入还需要对应适配器；没有连接时只能使用明确支持的台账或会话关联功能。

不要直接修改 Superagent 的数据库或子模块来绕过缺失接口。核验清单见 [接入能力与待验证项](integration-gaps.md)。

## 数据备份

使用内置命令创建数据库快照与对应附件的 ZIP 备份；可以在源服务仍运行时执行：

```powershell
.\.venv\Scripts\python.exe -m teamhub backup --data-dir .\data-team --output .\backups\teamhub-backup.zip
```

命令拒绝覆盖已存在的备份文件。下一次备份应换用新文件名。恢复时先停止要替换的服务，把备份解压到一个新的空目录，再按原模式启动：

```powershell
Expand-Archive -LiteralPath .\backups\teamhub-backup.zip -DestinationPath .\data-restored
.\.venv\Scripts\python.exe -m teamhub serve --data-dir .\data-restored --port 8765
```

以上示例恢复正式空间。演示备份需继续带 `--demo`。恢复后原成员令牌仍然有效；先检查事项与附件，再让成员继续写入。

若采用手动目录备份，须先停止写入服务，并复制完整目录。仅复制主数据库文件可能遗漏附件或数据库旁文件。备份含身份及操作回执，与原数据目录采用相同的保管要求。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 端口被占用 | 换一个端口，并同步修改访问地址与客户端配置 |
| 页面显示连接失败 | 检查服务是否启动、服务地址是否正确、请求是否带有效令牌 |
| 报版本冲突 | 刷新事项，读取新责任和状态后重试当前意图 |
| 找不到个人待办或 Superagent | 检查适配器能力探测结果；不能仅凭插件已安装判断已接入 |
| 运行状态 unknown | 核对原会话与进程，不直接换电脑重复执行 |
| 演示目录被正式模式拒绝 | 使用独立正式目录初始化，不把演示身份迁入正式服务 |
| 提示工作空间尚未初始化 | 对提示中的同一目录执行 `python -m teamhub init --data-dir ...`；不要删除已有数据库 |
