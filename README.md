# Agent Team Hub

面向 DSH 和其他 Agent Harness 的跨组协作台账与共享工具库。首版将事项责任、版本化交付、人工验收、Agent 执行记录和共享能力包放进一个可自托管的工作空间。

> 当前源码版本：0.3.0。已实现独立于 DSH 的服务、CLI 与 48 个 MCP 工具，支持串行流水线，并提供 Claude Code、Codex、OpenCode 的配置生成与项目 Skill 安装。看板和执行器可通过版本化适配器协议接入；DSH 看板与 Superagent 是可选适配器。

## 现在可以做什么

- 跨团队发起、接单、开工、记录进展与阻塞、请求转交、取消。
- 用明确的验收条件、交付物版本和具名验收人完成交付闭环；新交付替换旧待验收版本。
- 创建、校验、发布和复制串行流水线模板；按固定模板版本创建任务，为步骤绑定团队与验收人，前一步验收后自动发起下一组协作。
- 流水线支持退回重做、拒收后重新指派、暂停／恢复与取消；每轮固定上下文，旧轮次不能提交或验收新交付。
- 在已启用 Hub 接入的 DSH 看板中，以稳定外部键关联流水线步骤并自动同步业务状态；本地内容和 Superagent 工单状态各自保留。
- 使用通用协议接入其他看板或执行器；可选进程内 Node 接口或跨语言 JSON-RPC stdio，并按真实能力声明启动、状态查询、取消和恢复。
- 维护事项依赖，避免循环；前置事项验收通过后才允许开始。
- 分别记录本地待办绑定和 Agent Run。Run 成功只更新执行证据，业务事项仍需交付与验收。
- 发布六种能力类型的元数据及不可变文本版本包；下载 Skill/脚本、维护团队固定版本工具集。
- 通过中文 Web、CLI、HTTP API、标准 MCP stdio 及 DSH 工具插件访问相同数据。
- 不安装 DSH，也能通过 MCP 完成接单、交付材料上传与读取、具名验收、工具版本发布及团队工具集管理。
- 将共享 Skill 固定版本安装到 Claude Code、Codex 或 OpenCode 的项目发现目录；通过通用 CLI 安装并显式运行共享脚本。
- 使用 SQLite 单实例服务，提供幂等写入、版本冲突检测、事件游标与数据库/附件备份。

本项目不内置模型账户或远程执行集群。流水线引擎目前限定为串行的“工作＋验收”步骤；并行与跨步骤回退尚未实现，流程推进不会自动派发 Agent。共享能力库中的 workflow/app 类型仍用作目录和资料发布。脚本仅在用户明确调用时于客户端运行。

流水线操作与接口示例见 [串行流水线说明](docs/pipeline-workflows.md)。

## 五分钟启动

需要 Python 3.11+；从源代码构建界面及使用 CLI 需要 Node.js 22+。DSH 插件要求 Node.js 24.9+，当前版本已在 DSH 0.2.2-rc.1 隔离环境验证，rc.2 的当前版本仍需复验。源码交付包含预构建界面时，启动服务可跳过 Node 构建。

### 使用其他 Agent Harness

使用团队已有 Hub，或通过下文启动一个独立服务；不需要 DSH。安装项目的 `[mcp]` extra 后，生成目标宿主配置：

```powershell
$env:TEAMHUB_TOKEN = "<当前成员令牌>"
.venv\Scripts\python.exe -m teamhub.harness_config --harness claude-code --url http://127.0.0.1:8765 --output teamhub-mcp.fragment.json
```

`--harness` 支持 `claude-code`、`codex`、`opencode`（V2）、`opencode-v1` 和 `generic`；Codex 输出 TOML，其他输出各自的 JSON。将片段合入宿主配置；已有文件不会被生成器覆盖。配置不包含实际令牌值，桌面或通用客户端可改用 `--connection-file`。

连接后调用 `hub_context` 验证身份，再使用台账与共享工具。完整配置、Skill 安装和一条跨宿主业务流程见 [跨 Harness 接入](docs/cross-harness.md)，实际客户端验证范围见 [宿主验证记录](docs/harness-host-verification.md)。

### 安装到现有 DSH（Windows）

在解压后的项目根目录运行，DshPath 换为本机当前使用的 DSH 启动器：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-dsh.ps1 -DshPath "C:\path\to\dsh.cmd" -Profile web
```

安装器检查现有版本和 profile，安装项目依赖，启动本机 Hub，验证身份，安装插件并保存连接配置。它会复用已有工作空间；不会重建现有 profile 或升级 DSH。完成后重启同一 DSH profile，再调用 `teamhub_status`。

需要 Python 3.11+、Node.js 24.9+ 和现有 DSH 插件管理所用的 pnpm。参数与重复执行说明见 [Windows DSH 安装](docs/dsh-installation.md)。Windows 隔离 profile 的真实宿主与看板跨组流程已验证；已有正式 profile 仍需单独升级与验收。

### Windows PowerShell

```powershell
Set-Location -LiteralPath '<项目所在目录>'
powershell -ExecutionPolicy Bypass -File .\scripts\start.ps1 -Demo
```

访问 **http://127.0.0.1:8765**。演示空间包含交易、清算、质量保障三个团队、六个协作事项和三个示例能力。顶部会持续标记演示模式，可以在连接设置里切换演示身份走完整个流程。

创建独立的正式空间：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start.ps1 -DataDir .\.teamhub
```

首次启动会在终端输出管理员令牌。将令牌粘贴到页面连接设置中；由管理员创建团队和成员，成员使用各自令牌连接。演示与正式目录不能混用。

### Linux / macOS

```bash
bash scripts/start.sh --demo
# 正式空间：bash scripts/start.sh --data-dir .teamhub
```

脚本按 `constraints-tested.txt` 安装本次已验证的 Python 直接依赖版本；仅在不存在 web/dist 时安装前端依赖并构建。修改前端源码后需主动重新执行 `cd web && npm ci && npm run build`。

### 手动安装

```bash
python -m venv .venv
# Windows: .venv\Scripts\Activate.ps1
# Linux/macOS: source .venv/bin/activate
python -m pip install -e '.[mcp,dev]'
cd web
npm ci
npm run build
cd ..
python -m teamhub serve --demo --port 8765
```

首次正式初始化：

```bash
python -m teamhub init --data-dir .teamhub --name '管理员' --team-name '交易研发组'
python -m teamhub serve --data-dir .teamhub
```

开发时可在第二个终端运行 `cd web && npm run dev`，Vite 会把 `/api` 代理到 8765。

## 接入 DSH 与其他 Harness

通用客户端快速接入见 [跨 Harness 接入](docs/cross-harness.md)，适配器协议、能力发现与示例见 [通用接入协议 v1](docs/adapter-protocol-v1.md)；具体包安装与 DSH 加载见 [packages/INTEGRATION.md](packages/INTEGRATION.md)。

```bash
# CLI: 先设置 TEAMHUB_URL 和 TEAMHUB_TOKEN
node packages/cli/bin/teamhub.mjs --help

# 官方 Python MCP SDK 提供 stdio 工具，同样使用上面的环境变量
python -m teamhub.mcp_server
```

`packages/dsh-plugin` 注册真实 DSH 工具，调用共享 API。启用兼容的 `dsh-todo-kanban` 服务后，可关联并自动同步流水线；也可显式配置其他看板和执行器适配器。可选 Superagent 适配器有固定目录、工具版本及停止确认限制，详见 [协议说明](docs/adapter-protocol-v1.md)。已有环境的备份、升级和回滚见 [0.3.0 升级说明](docs/adapter-upgrade.md)。

HTTP API 交互文档：**http://127.0.0.1:8765/docs**。所有业务读取和写入都使用 Bearer 身份令牌；健康检查和显式演示身份入口除外。动态事项操作的请求结构见 [实现契约](docs/implementation-contract.md)。

已有 `distributions/agent_team_hub-0.1.0-py3-none-any.whl` 是流水线实施前的历史构建，不包含当前源码新增功能。使用本次功能请从源码安装；需要 wheel 时应先重新构建并验证安装产物，再用于新的发行包。

## 业务规则

事项状态：`open → accepted → active → review → done`，可在未结束时取消。阻塞独立记录，不替代业务状态。请求发出后仍由原团队负责，接单或接受转交才改变责任归属。

每次写入携带稳定的 `operation_id`，事项变更还携带 `expected_version`。同一次网络重试复用原编号，内容发生变化时创建新编号。旧事项版本返回 409；同操作编号换内容也返回 409。

交付冻结当前 `spec_revision`。验收只针对当前交付和当前验收条件；修改条件或提交新交付后，旧交付不能被误验收。只有具名验收人可以通过或退回，管理员身份本身不获得代验权限。

流水线步骤沿用上述事项、交付和验收规则，并要求处理人与验收人为不同账号。流程步骤写入还需要当前轮次 ID 和流程 generation；退回后生成新轮次，通过验收才创建下一步骤事项。账号隔离不能单独证明由真人完成操作，使用 MCP 的验收操作应在宿主侧安排人工确认。

Run 记录包含 `dispatch_id`、客户端实例、输入快照、能力固定版本、事件序号。未知结果仍占用执行位置；重复点击或另一台机器不能并行启动同一事项。取消只是请求停止，需执行方确认；运行结果不自动关闭事项。事件同步不会触发执行。

## 数据与备份

每个服务只使用一个数据目录：`teamhub.db` 与 `artifacts/`。不同客户端通过 HTTP 访问同一个服务，不共享网络磁盘上的 SQLite 文件。正式团队部署时在内网主机运行服务并配置 HTTPS 反向代理；首版默认仅监听本机。

```bash
python -m teamhub backup --data-dir .teamhub --output backups/teamhub-2026-11-12.zip
```

备份使用 SQLite 在线快照，并复制该快照引用的不可变附件。恢复时停止服务，将备份解压到一个新目录，然后通过 `--data-dir` 启动。备份包含身份和操作回执，应与原数据目录同等保管。

启动当前源码会在事务中把数据库结构从 v1 升级到 v2。升级前请用上述命令保存独立备份；如需回退到旧程序，请停止服务并恢复升级前备份到新目录。旧事项保留原有行为，旧附件不会补算哈希。

成员身份表保存令牌摘要；创建成员的幂等回执会保留首次分发结果。普通 bootstrap、列表、事件不返回令牌。尚未实现 SSO、细粒度项目可见性和成员令牌轮换；此版定位为一个互信团队工作空间。

## 项目结构

| 路径 | 内容 |
|---|---|
| `server/teamhub/` | FastAPI、SQLite 事务、领域规则、MCP stdio、宿主配置生成 |
| `web/` | React、TypeScript、Vite 中文工作台 |
| `packages/client/` | 无框架 Node HTTP 客户端、本地桥接和能力安装 |
| `packages/cli/` | 跨 Harness 命令行入口 |
| `packages/dsh-plugin/` | DSH bundle、工具注册、扩展适配器 |
| `examples/` | 可安装 Skill 和可运行脚本 |
| `tests/` | 基于真实 HTTP 与 SQLite 的行为测试 |
| `docs/` | 架构、契约、Windows 启动、验收与接入差距 |

## 验证和贡献

```bash
python -m pip install -e '.[mcp,dev]'
python -m pytest
cd web
npm ci
npm run build
```

接入层测试命令见 `packages/INTEGRATION.md`。验证记录见 [docs/acceptance.md](docs/acceptance.md)。

这是独立实现，未复制 HajimiWorkbench 或 dsh-task-ledger 源码，也未修改现有 Superagent 子模块。已核对本机看板接口并实现可选关联；Superagent 执行适配器基于已核对的管理接口，实际派发与停止确认的验证范围见 [协议说明](docs/adapter-protocol-v1.md)。

“其他 harness 可接入”指通过通用业务接口使用台账、流水线、交付验收与能力库，也可以实现本机看板或执行器适配器。自动控制具体宿主仍需实现并验证该宿主的真实适配器。DSH 看板与两组业务流程已在本机 DSH 0.2.2-rc.1 的隔离 profile 中验证；本机正式 profile 已切换至 0.3.0 并验证旧关联。

开源许可证：**MIT**。完整实施范围与后续接入事项见 [架构说明](docs/architecture.md) 和 [接入差距](docs/integration-gaps.md)。
