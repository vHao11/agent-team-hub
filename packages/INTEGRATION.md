# 接入说明与实际支持范围

本项目把共享台账、能力目录和业务状态保存在 Hub 服务；CLI、MCP、DSH 都使用同一套 Bearer Token HTTP API。客户端不打开服务端数据库。所有包当前为本仓库交付物，尚未发布到 npm、PyPI 或 DSH 插件市场。

## 1. 支持矩阵

| 接入方式 | 已实现 | 本环境验证 | 仍需目标环境确认 |
| --- | --- | --- | --- |
| HTTP 客户端 `@agent-team-hub/client` | 台账、交付、审核、附件上传、绑定、Run、能力版本与组工具集 | Node 24 测试；异常、版本冲突、幂等请求转发 | 实际网络与正式成员权限配置 |
| CLI `@agent-team-hub/cli` | JSON 输入输出、离线进度队列、固定版本安装与显式脚本执行 | 子进程 → HTTP 测试、安装路径与执行测试 | Windows 路径、Python 安装位置 |
| 官方 Python MCP SDK | 47 个工具；stdio；协作、串行流水线、文本交付验收、能力发布与团队工具集 | 官方 `ClientSession` → stdio → 真实 Hub；双身份业务和三身份跨组串行流程闭环 | 宿主权限与真实会话 ID 获取 |
| DSH bundle `dsh-team-hub` | 22 个 `teamhub_*` 原生工具；流程关联与 AdapterRegistry 扩展点 | Windows rc.1 隔离 profile 的真实注册与跨组流程；原 0.1.0 曾测 Linux rc.1、rc.2 | 0.2.0 在 rc.2 和用户正式 profile 的验证 |
| DSH 待办看板自动联动 | 可选 Cordis 看板服务、稳定外部键关联、状态投影与掉线提示 | 真实 `dsh-todo-kanban`、DSH rc.1、Hub 和浏览器的隔离闭环 | 目标 profile 更新、重启和正式数据备份 |
| 增强 Superagent 自动启动 | `ExecutionAdapter` 契约、单次派发、本机持久记录、状态核对、确认取消 | 用测试适配器验证不重复启动、崩溃恢复、取消确认 | 已核对现有看板的工单投影；Superagent 执行适配器与真机派发尚未实现 |
| 其他 agent harness | 专用配置生成、MCP/CLI、显式 session 绑定与 Run 回传 | 通用业务测试及真实客户端检查，见[宿主验证记录](../docs/harness-host-verification.md) | 各宿主自动启动/取消/看板仍需专用适配 |
| 共享工具库 | Skill/脚本样例、不可变版本、宿主 Skill 安装目录、工具集引用 | 三种目录实际写文件；样例脚本可运行；安装不执行代码 | MCP/plugin/workflow/app 类型目前为目录与 manifest；既有宿主会话的 Skill 加载需确认 |

DSH 默认探测 `dsh-todo-kanban` 的可选进程内服务；缺少兼容服务时 `teamhub_status` 显示看板不可用。默认没有 Superagent ExecutionAdapter，不会用模拟结果声称已启动真实 Agent。

## 2. CLI

从仓库根目录构建，无需安装任何 CLI npm 依赖：

```powershell
node packages/cli/build.mjs
$env:TEAMHUB_URL = "http://127.0.0.1:8765"
$env:TEAMHUB_TOKEN = "<当前成员的令牌>"
node packages/cli/bin/teamhub.mjs whoami
node packages/cli/bin/teamhub.mjs items list --view inbox
```

令牌由服务端正式初始化或创建成员时获得。只有显式 `--demo` 演示服务才接受 `demo-lin`、`demo-chen`、`demo-xu`。切换成员只改变该客户端的认证上下文，不赋予额外业务权限。

可以打包后安装到本机：

```powershell
Push-Location packages/cli
npm pack --pack-destination dist
Pop-Location
npm install -g ./packages/cli/dist/agent-team-hub-cli-0.1.0.tgz
teamhub --help
```

本仓库已附带上述 tarball。首次自行打包前若 `dist` 不存在，先创建目录。CLI bin 为 `teamhub`；Python 服务端命令使用 `python -m teamhub` 或 `teamhub-server`，不要混淆两者。

### 业务命令

JSON 文件可以包含中文，支持 UTF-8 与 UTF-8 BOM。以 `items get` 返回的 `item.version` 填入 `--version`；请求失败后保留原来的 `operation_id`，不要盲目生成新 ID 重试。

```powershell
# create.json 示例见下方；真实 ID 先从 whoami 获取。
node packages/cli/bin/teamhub.mjs items create --data '@create.json' --operation-id request-20261112-001
node packages/cli/bin/teamhub.mjs items get <WORK_ITEM_ID>
node packages/cli/bin/teamhub.mjs items accept <WORK_ITEM_ID> --version 1 --operation-id accept-20261112-001
node packages/cli/bin/teamhub.mjs items start <WORK_ITEM_ID> --version 2 --operation-id start-20261112-001
node packages/cli/bin/teamhub.mjs items progress <WORK_ITEM_ID> --version 3 --data '@progress.json' --operation-id progress-20261112-001
```

创建文件 `create.json`：

```json
{
  "title": "核对新接口的清算回报字段",
  "description": "检查字段兼容与调用链，整理联调证据。",
  "project_id": "proj-interface",
  "target_team_id": "team-clearing",
  "acceptance_spec": ["列明新增字段与兼容行为", "提供回归测试记录"]
}
```

这些项目/组 ID 属于演示空间，正式空间使用 `whoami` 返回的 ID。接单必须使用目标组成员令牌；`start` 登记人工处理，不启动本机 Agent。

`progress.json` 示例为 `{"summary":"已核对字段表","next_action":"补充异常回报测试"}`。更新后再次读取版本，再执行下一次写入。上面的连续数字仅说明版本变化，实际并发环境应以服务端返回为准。

本机交付文件可以先上传，获得 `artifact://...`：

```powershell
node packages/cli/bin/teamhub.mjs artifacts upload ./report.md
node packages/cli/bin/teamhub.mjs items submit <WORK_ITEM_ID> --version <CURRENT_VERSION> --data '@delivery.json' --operation-id delivery-20261112-001
```

`delivery.json` 包含 `spec_revision`、`summary`、`artifacts: [{"label":"接口分析报告","url":"artifact://<上传返回的ID>"}]`，可附 `run_ids`。本地 `D:\...` 路径不作为共享交付链接。提交后进入待验收，只有指定验收人的明确审核操作会完成事项。

### 显式 session 绑定与运行回传

此路径适合尚未提供原生扩展 API 的 harness。由调用方取得真实 session ID，再登记，不能凭空推断当前会话。

```powershell
node packages/cli/bin/teamhub.mjs bind <WORK_ITEM_ID> --data '@binding.json'
node packages/cli/bin/teamhub.mjs runs register <WORK_ITEM_ID> --version <CURRENT_VERSION> --data '@run.json' --operation-id run-20261112-001
node packages/cli/bin/teamhub.mjs runs get <RUN_ID>
node packages/cli/bin/teamhub.mjs runs report <RUN_ID> --data '@run-event.json' --operation-id report-20261112-001
```

`binding.json` 包含 `harness`、`workspace_ref`、`session_id`，可附稳定 `local_todo_id`。`run.json` 包含 `harness`、`workspace_ref`、`external_session_id`，可附 `capabilities: [{"capability_id":"...","version":"0.1.0"}]`；省略时由服务端解析该组当前工具集并固定版本。`runs register` 只登记，不启动程序。

`run-event.json` 示例为 `{"sequence":1,"status":"running","external_session_id":"<真实会话ID>","summary":"执行已由本机宿主确认"}`。每次回传使用比最新 Run 更大的 `sequence`。后续 `succeeded` 只结束 Run，事项仍需要交付与验收。`unknown` 保留执行占用，核对已有会话后再处理，不允许因网络重连偷偷启动第二次执行。

CLI 默认将稳定 `client_instance_id` 保存在 `TEAMHUB_STATE_DIR` 或用户目录的 `.agent-team-hub`。同一 Run 的回传必须使用原客户端实例；可显式提供 `--instance`。持久记录不保存令牌。

### 离线进度

`items progress ... --queue --actor-id <已知用户ID>` 显式写入本机 outbox。`outbox replay` 先核验当前成员和 Hub 地址，再按原操作 ID、原版本回放。冲突保留到队列中，需读取最新状态后明确处理。队列只接受进度更新，不缓存接单、启动或验收命令；事件回放也不触发执行。

## 3. 工具库的发布、安装和运行

`examples/capabilities/interface-review` 是带报告模板的 Skill；`examples/capabilities/log-summary` 是标准库 Python JSONL 摘要脚本。演示库与样例均使用 `0.1.0`，服务端 wheel 中包含同内容副本。

```powershell
node packages/cli/bin/teamhub.mjs tools list
node packages/cli/bin/teamhub.mjs tools show <CAPABILITY_ID> --version 0.1.0
node packages/cli/bin/teamhub.mjs tools install <CAPABILITY_ID> --version 0.1.0 --directory D:/team-tools/log-summary/0.1.0
node packages/cli/bin/teamhub.mjs tools run D:/team-tools/log-summary/0.1.0 -- --file D:/logs/session.jsonl
```

安装只复制固定发布的 UTF-8 文本文件；不执行 install hook、不运行 shell、不自动加载 Skill。路径穿越、符号链接目标、Windows 保留文件名、大小写文件冲突会被拒绝。当前服务端发布上限为 **2 MiB / 100 个文本文件**；客户端另外设有 10 MiB / 1000 文件的安装防护，实际使用应遵守服务端更严格的限制。已存在的其他版本不会被覆盖，手动目录模式应选择新版本目录。运行脚本是单独的显式动作，使用 argv 调用 Python/Node；这不是代码沙箱。Python 路径可用 `TEAMHUB_PYTHON` 设置。Skill 文件安装后由目标 harness 按其实际规则发现和加载。

现已提供三种经过官方文档核对的项目 Skill 目录：

```powershell
node packages/cli/bin/teamhub.mjs tools install <CAPABILITY_ID> --version 0.1.0 --harness codex --workspace D:/projects/trading-service
```

`--harness` 支持 `claude-code`、`codex`、`opencode`，与 `--directory` 互斥；workspace 必须已存在，内容必须为带有效 name/description 的 Skill。此模式实际安装文件，不会控制宿主强制重新加载；同目录的不同发布版本拒绝覆盖。目录映射、升级和旧演示数据注意事项见 [跨 Harness 接入](../docs/cross-harness.md)。

发布自定义包时，先建立能力目录，再生成可以审查的 release JSON：

```powershell
node packages/cli/bin/teamhub.mjs tools publish --data '@capability.json'
node examples/build-release.mjs examples/capabilities/log-summary ./log-summary-release.json
node packages/cli/bin/teamhub.mjs tools release <CAPABILITY_ID> --data '@log-summary-release.json'
```

`capability.json` 包含 `slug`、`name`、`description`、`kind`、`tags`。发布同版本不可覆盖；改变内容必须使用新版本。`build-release.mjs` 不发布或执行代码，只生成包含固定 `operation_id`、manifest 和文件内容的请求。`toolsets get/set` 管理组工具集，更新需要相应组权限和工具集 `expected_version`。

## 4. MCP stdio

安装项目时启用官方 SDK extra：

```powershell
.venv/Scripts/python.exe -m pip install -e ".[mcp]"
$env:TEAMHUB_URL = "http://127.0.0.1:8765"
$env:TEAMHUB_TOKEN = "<当前成员令牌>"
.venv/Scripts/python.exe -m teamhub.mcp_server
```

此命令等待 MCP JSON-RPC stdio 输入，适合由宿主启动。不要把 Hub HTTP 地址误当成远程 MCP endpoint。`python -m teamhub.harness_config --harness <目标>` 会生成宿主自己的 JSON/TOML；各宿主示例位于 `examples/mcp/`，Python 路径应为本机绝对路径。生成器支持私有连接文件，也支持目标宿主正确的环境变量写法。配置与加载步骤见 [跨 Harness 接入](../docs/cross-harness.md)。

工具共 47 个：原有台账、材料、能力目录、工具集、绑定与 Run 工具之外，新增模板的查询、创建、编辑、校验、发布、复制，以及流水线的创建、管理、重新指派和步骤操作。具体调用和轮次约束见 [串行流水线说明](../docs/pipeline-workflows.md)。业务写工具要求稳定操作 ID，版本化操作要求 `expected_version`；附件上传不提供幂等回执，应引用实际返回的附件 ID。文本附件上限 2 MiB UTF-8，二进制使用 Web/CLI。MCP 不自动执行脚本或启动 Agent。标准输出只用于协议；日志和配置错误进入 stderr。

HTTPX 默认不继承系统代理变量，便于连接本机和明确配置的 Hub。确需组织代理时显式设置 `TEAMHUB_TRUST_ENV=1`，并安装该代理所需的 HTTPX 组件。

## 5. DSH 原生 bundle

实现依据为官方 [构建工具文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/tool.md)、[配置文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/config.md) 和 [bundle 安装文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)。SDK 开发依赖固定 `0.2.2-rc.2`，Node 要求 `>=24.9.0`。原版插件曾在官方 DSH `0.2.2-rc.1` 和 `0.2.2-rc.2` 验证加载；当前 0.2.0 已在 Windows rc.1 验证真实看板流程，rc.2 尚未复测。`engines.dsh` 与 SDK peer 声明这两个版本；其他版本需要重新验证后调整。

```powershell
node packages/dsh-plugin/build.mjs
Push-Location packages/dsh-plugin
npm pack --pack-destination dist
Pop-Location
dsh plugin --profile web add ./packages/dsh-plugin/dist/dsh-team-hub-0.2.0.tgz
dsh --profile web --dump-config
```

应先从当前源码构建 tarball。安装前设置 `TEAMHUB_URL`、`TEAMHUB_TOKEN`，或沿用当前 profile 的 `tokenFile`；重启该 profile 后调用 `teamhub_status`。`--dump-config` 只能证明配置合成，不等于工具已在实际会话成功运行。profile 名称以用户已有环境为准。不要为接入本项目重建用户现有 profile。

包通过 `inject = ['tools']` 与 `ctx.tools.register(defineTool(...))` 注册原生工具。配置可设置 `serverUrl`、`tokenEnv`、`tokenFile`、`stateDir`、`clientInstanceId`、`timeoutMs` 和 `boardSyncSeconds`。`tokenEnv` 是环境变量名；`tokenFile` 是现有本机私有令牌文件的路径，均不把令牌值写入配置或订阅。

原生工具为 `teamhub_status`、台账/目录工具、显式绑定/Run 登记/状态回传，以及 `teamhub_board_link/run_start/run_reconcile/run_cancel`。后一组依赖真实适配器。`run_reconcile` 需要显式调用，不含未经请求的后台自动调度。

### 接入真实待办看板与增强 Superagent

扩展插件从 `dsh-team-hub/adapters` 导入 `adapters` 并注册适配器；类型契约位于 `packages/client/src/contracts.d.ts`，完整接线模板位于 `examples/adapters/register-known-host.mjs`。这是本项目的扩展点，不是声称存在的 `ctx.todoBoard` 或 `ctx.superagent` API。

`BoardAdapter` 需要 `probe()` 与 `ensureLinkedCard()`：以共享 external reference 去重，返回宿主真实持久卡片 ID。若宿主只提供没有稳定 ID 的整表快照，必须先给宿主补充持久映射机制，不能拿数组下标或标题当共享主键。

`ExecutionAdapter` 需要 `probe()`、`start()`、`getStatus()`，可选 `cancel()` 和 `findByDispatchId()`。`start()` 接收服务端冻结的 `input_snapshot`、`spec_revision`、`assignment_generation`、`capability_releases` 和唯一 `dispatch_id`，真实执行应使用该快照。它必须返回真实 `session_id` 或 `run_id`，不能拿共享事项 ID 冒充会话 ID。

本机桥在启动前写入持久派发记录；若宿主启动结果丢失，记录保持待核实，后续请求不会重复启动。宿主若提供按 dispatch ID 查询，可恢复已有执行。取消请求与确认停止分开，只有实际适配器确认后才回传 `cancelled`。此机制依赖本机状态目录保留；删除状态记录不等于取消外部执行，服务端仍保留未结束 Run。

建议每个 DSH 会话选择原生工具或本项目 MCP 一种入口，避免重复工具集合。外部适配插件应将 registry 返回的卸载函数接入其实际生命周期；具体 lifecycle API 必须依据该插件所用 Cordis/DSH 版本编写。

## 6. 验证命令与界限

```powershell
node packages/cli/build.mjs
node packages/dsh-plugin/build.mjs
npm --prefix packages/dsh-plugin ci --ignore-scripts
node --test packages/client/test/*.test.mjs packages/cli/test/*.test.mjs packages/dsh-plugin/test/*.test.mjs
.venv/Scripts/python.exe -m pytest packages/mcp/test_mcp.py -q
.venv/Scripts/python.exe -m pytest packages/integration/test_live_http.py -q -s
.venv/Scripts/python.exe -m pytest packages/integration/test_mcp_workflow.py -q
```

Node 契约测试覆盖认证、冲突回传、CLI HTTP 调用、路径安全、显式执行、固定版本、派发不重启、状态恢复和确认取消。DSH 单元测试调用真实 SDK，但 ctx 和宿主适配器为测试替身。另有 `scripts/verify-dsh-host.py` 在隔离目录安装并启动官方宿主，直接调用真实注册工具读取 Hub；该核验不调用模型，也不运行用户增强 Superagent。本机 Windows 与自定义 DSH 插件验收参照 `docs/integration-gaps.md`。

原有 CLI + MCP 闭环启动独立 FastAPI/SQLite 服务，经 CLI 创建/接单/登记 Run，安装固定 `0.1.0` 日志工具并执行，校验 `INFO=2 / WARN=1 / ERROR=1`；回传成功后事项仍为 `active`。随后经 MCP 更新进度，CLI 上传实际附件、提交交付，并由指定验收人审核后才变为 `done`。

新增 MCP-only 测试在两个成员身份之间独立完成能力发布、固定团队工具集、创建、接单、运行状态回传、文本报告上传/读取、提交和验收；另外覆盖责任转交、依赖、取消确认和附件边界。测试使用官方 MCP SDK、真实 stdio 子进程及 HTTP/SQLite，不靠 DSH 或 CLI 补齐业务。合并测试数量和结果见 [验收记录](../docs/acceptance.md)。

先验证查询、身份、版本冲突和显式会话绑定，再接真实看板与增强执行器。只有宿主回传真实 ID、执行结果和交付证据后，才能确认对应的宿主接入完成。
