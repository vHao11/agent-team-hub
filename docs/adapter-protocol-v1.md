# 通用接入协议 v1

Agent Team Hub 将共享业务事实保存在 Hub；Agent Harness、个人看板和执行器通过可替换的本机适配器接入。DSH 待办看板及 Superagent 分别提供可选适配器，其他宿主可按自身真实接口实现适配。协议不依赖 DSH。

## 两层接口

1. **业务接口**：所有宿主使用带成员身份的 HTTP `/api/v1`、MCP stdio、CLI 或 DSH 原生工具操作同一个 Hub。先读取事项与流水线轮次，再执行带 `operation_id`、`expected_version` 的明确命令。`GET /api/v1/integration/contract`、MCP 的 `hub_integration_contract`、CLI 的 `teamhub contract` 和 DSH 的 `teamhub_integration_contract` 返回 Hub 支持的协议版本与业务语义。
2. **本机适配器接口**：Hub 客户端与看板或执行器之间使用本文的协议；可由 Node 进程内接口实现，也可用任意语言通过 JSON-RPC stdio 实现。适配器只对接已经核实的宿主接口。Hub 的协议发现不表示某个本机适配器已经安装或可用；用 `teamhub adapters list` 或 DSH 的 `teamhub_status` 探测实际配置。

机器可读的配置、能力声明及消息格式分别见 [`adapter-config-v1.schema.json`](../packages/client/schemas/adapter-config-v1.schema.json)、[`adapter-description-v1.schema.json`](../packages/client/schemas/adapter-description-v1.schema.json) 和 [`adapter-wire-v1.schema.json`](../packages/client/schemas/adapter-wire-v1.schema.json)；进程内 TypeScript 接口见 [`contracts.d.ts`](../packages/client/src/contracts.d.ts)。

## 生命周期与业务约束

- 成员身份由 Hub 的令牌决定。本地状态按 Hub 地址、成员、客户端实例、适配器和流程隔离；换身份后不能控制别人登记的本机执行。
- `external_ref` 是 Hub API 基地址和事项 ID 组成的稳定键；相同键重复关联必须返回同一张卡，不使用标题或数组下标。多看板可以订阅同一流程；DSH 旧订阅路径继续有效。
- 看板接收 Hub 业务快照；具备业务操作入口的宿主可在核实当前身份、版本和轮次后调用 Hub 的明确命令，不能将本地拖列当作业务验收。没有 `detach_pipeline` 时，取消订阅会停止同步但保留外部关联；看板与本地字段不会被删除。
- 执行只在明确调用启动或为当前成员和流程显式启用自动派发后发生。Run 在 Hub 中固定输入、验收条件、流程轮次与工具版本；适配器必须使用该快照，不能自行替换为较新的事项或工具版本。不支持所需能力时不得声称已启动。
- 适配器返回稳定会话或执行句柄，并如实报告排队、启动中、运行中或等待人工。Run 成功是执行证据，只有具名验收通过才完成业务事项。
- 丢失启动响应、进程崩溃或超时后保留 `unknown`，不会因重连自动再次派发。支持 `recover` 时按原 `dispatch_id` 查找已有运行；找不到时保留待核实。适配器和宿主还应使用该 ID 做幂等去重，Hub 不承诺跨外部系统的严格一次执行。
- 取消请求与停止确认分离。只有宿主能够确认实际执行已停止时才回传 `cancelled`；只有请求回执时返回 `requested: true, confirmed: false`，后续通过状态核对确认。已结束的运行不会再次调用宿主取消。
- 断线时保留最后快照与关联；重新对账不重放执行或验收。相同业务请求重试沿用原 `operation_id`，不同意图使用新 ID。不同进程对同一 Hub 和看板使用本机同步锁，避免对账与解除关联交叉；进程崩溃遗留锁时，可用 `pipelines unlock --adapter <名称>` 检查，只有能确认原进程已经退出才会清除。无法确认的锁需人工核对。

## 本机配置

配置文件由本机维护者显式指定，不从共享能力库自动下载、安装或运行程序。`command` 与 `args` 使用独立 argv，适配器由当前用户权限启动；本协议不提供沙箱。配置可以引用本机适配器所需的环境变量**名称**，不应写入令牌值。Hub 的 `TEAMHUB_*` 环境变量不会转发给子进程，也不能在 `env` 中要求转发。

```json
{
  "schema_version": 1,
  "adapters": [
    {
      "name": "local-json-board",
      "kind": "board",
      "command": "python",
      "args": ["<适配器脚本的绝对路径>", "<本机状态目录>/board.json", "local-json-board"],
      "env": [],
      "timeout_ms": 20000
    }
  ]
}
```

`name` 同时用作 Hub 绑定中的 harness 名称，必须和适配器描述一致且在同类注册中唯一。`command` 可为本机 PATH 命令或绝对路径；相对 `cwd` 按配置文件目录解析。仅继承必要的操作系统路径、主目录、临时目录和语言变量，其他变量通过 `env` 明确列出。超时范围为 100–120000 毫秒，默认 20000 毫秒。配置和描述版本不兼容时拒绝使用。

Python 标准库示例 [`local-json-board.py`](../examples/adapters/local-json-board.py) 实现真实的本地 JSON 看板关联，状态文件必须位于已存在的目录；它不依赖 DSH，也不启动 Agent。示例锁文件冲突时拒绝写入，异常遗留锁需维护者核实后处理。

## JSON-RPC stdio

客户端为每个操作启动一次适配器进程，在 stdin 写入一行 UTF-8 JSON-RPC 2.0 请求并关闭输入；进程在 stdout 返回一条包含相同 `id` 的 JSON 响应并以 0 退出。stdout 只用于协议，诊断写 stderr；客户端不把 stderr 原文转发给 Hub。请求与响应各限 2 MiB，超时、退出失败、无效 JSON、多个响应或 ID 不匹配均为失败；不自动重试可能已产生外部副作用的启动请求。

请求示例：

```json
{"jsonrpc":"2.0","id":"request-1","method":"adapter.describe","params":{}}
```

看板的结果示例：

```json
{"jsonrpc":"2.0","id":"request-1","result":{"protocol":"agent-team-hub-adapter","protocol_version":1,"name":"local-json-board","kind":"board","version":"1.0.0","available":true,"capabilities":{"item_link":true,"pipeline_sync":true,"detach_pipeline":true}}}
```

执行器声明 `kind: "executor"`，`capabilities` 必须明确提供 `start`、`status`、`cancel`、`recover` 四个布尔值。`available: true` 的执行器必须支持前两项。不可用和不支持的能力不能伪装成成功。响应只能有 `result` 或 `error` 之一；远端错误内容不会作为可信业务结果。

### 看板方法

| 方法 | 参数 | 返回 |
| --- | --- | --- |
| `board.upsert` | `external_ref`、`workspace_ref`、`item`；流水线额外含 `snapshot`，指定已有卡片时含 `preferred_local_todo_id` | `local_todo_id`，可选 `session_id`、`created` |
| `board.detach_pipeline` | `pipeline_id`、`hub_base` | `detached` 非负整数；只移除该 Hub 流程的共享关联 |

`snapshot` 使用 `schemaVersion: 1`、`externalRef`、`itemId`、`pipelineId`、`stepKey`、`attemptId`、`generation`、`pipelineVersion`、`itemVersion`、业务状态、责任及更新时间，可选 `specRevision`、`currentDeliveryId` 和 `superseded`；完整字段见 TypeScript 声明。适配器应拒绝身份冲突及倒退版本，保留本地笔记等非 Hub 字段。`superseded` 表示跨步骤回退后历史卡片不可再执行当前轮次操作。`item_link`、`pipeline_sync`、`detach_pipeline` 分别声明上述能力；v1 的通用看板方法只规定 Hub 到看板的快照，反向操作使用业务接口，并非把拖列作为命令。

### 执行器方法

| 方法 | 参数 | 返回 |
| --- | --- | --- |
| `execution.start` | `item_id`、`run_id`、`dispatch_id`、`workspace_ref`、`input_snapshot`、`capability_releases`、`spec_revision`、`assignment_generation` | 至少一个稳定 `run_id` 或 `session_id`；可附初始 `status`：`queued`、`starting`、`running`、`waiting_input`，省略时为 `starting` |
| `execution.status` | `handle` | `status`：`queued`、`starting`、`running`、`waiting_input`、`succeeded`、`failed`、`cancelled` 或 `unknown`；可附 `summary` |
| `execution.find` | `dispatch_id` | 已有句柄，或 `null`；只查询，不新建执行 |
| `execution.cancel` | `handle` | `requested` 和 `confirmed` 布尔值 |

`execution.find` 和 `execution.cancel` 只在相应能力为 true 时调用。`workspace_ref` 是调用者提供的本地工作区定位信息；具体适配器必须核实宿主使用哪个目录，不能把它当成宿主已经接受该目录的证据。

## 在 CLI 和 DSH 中使用

复制并填写 [`stdio-board.example.json`](../examples/adapters/stdio-board.example.json)，指定真实脚本和状态文件。示例：

```powershell
node packages/cli/bin/teamhub.mjs adapters list --adapter-config '<本机配置.json>'
node packages/cli/bin/teamhub.mjs pipelines link '<流程ID>' --adapter local-json-board --workspace-ref '<工作区>' --adapter-config '<本机配置.json>'
node packages/cli/bin/teamhub.mjs pipelines sync --adapter local-json-board --adapter-config '<本机配置.json>'
node packages/cli/bin/teamhub.mjs pipelines unlink '<流程ID>' --adapter local-json-board --adapter-config '<本机配置.json>'
```

CLI 的 `automation enable` 可为当前成员和流程显式保存本机派发设置；`automation tick` 单次对账，`automation run` 持续运行，`automation disable` 关闭后续自动派发。未设置时不会自动启动。连接执行器后也可用 `runs start`、`runs reconcile` 和 `runs cancel-execution`；流水线步骤启动时在 `--data` 中提供当前 `pipeline_attempt_id` 和 `pipeline_generation`。已有的 `runs register/report/cancel` 仍是显式登记、回报和 Hub 取消请求，不会自行调用宿主执行器。

DSH 的 `dsh-team-hub` 可在本机插件配置中设置 `adapterConfigFile`，可选 `boardAdapter` 指定默认看板。`teamhub_pipeline_link/sync/unlink` 接受可选 `adapter` 名称；省略时保持原 `dsh-todo-kanban` 行为。DSH 为已注册看板定期对账，第三方进程内插件也可通过 `dsh-team-hub/adapters` 注册；卸载时应调用注册函数返回的清理函数。

### 可选 Superagent 适配器

本机 DSH 插件配置中显式设置 `superagentUrl: "http://127.0.0.1:<DSH端口>"` 才会注册 `dsh-superagent` 执行器；可选 `superagentTaskType` 指定已配置任务类型。它通过 Superagent 的本机管理接口发送固定执行快照及 `dispatch_id`（对应其 `requestId`），查询已有工单，并请求停止。默认不启动任务。

开始前适配器核实所选任务类型（或全局设置）使用固定目录，且该目录与 `workspace_ref` 指向同一实际目录；还会检查创建后工单的目录。Superagent 的创建 API 没有原子目录版本条件，运行期间应避免同时修改其目录配置；如果创建后发现目录不一致，适配器请求停止并将结果保留为待核实。当前 API 不能保证安装 Hub 固定能力版本，因此只允许没有固定能力的运行，其他请求在派发前拒绝。执行快照须符合 Superagent 请求长度限制。

当前已核实的 Superagent 版本可通过只读决策记录中的触发键找回丢失启动响应的工单；桥接在启动前保存必要的匹配信息，查找不到或宿主算法变化时保持 `unknown`，不自动重新派发。这依赖已核实版本的内部触发键算法，不应视为所有 Superagent 版本都提供的稳定按 ID 查询 API。停止接口返回的是请求回执，不能证明后台执行资源已退出；适配器返回 `confirmed: false`，人工核实停止后由原执行登记人使用 `teamhub_run_report` 或 MCP `hub_run_report` 回报。真实本机 Superagent 已完成只读合成模型任务，测试刻意丢失启动响应后找回同一工单，并完成隔离 Hub 的两组并行汇合与验收。

本机具有 Superagent 源码及其 Vitest 依赖时，可在本仓库构建 DSH 插件后运行 `scripts/verify-superagent-contract.test.ts`。将 `TEAMHUB_SUPERAGENT_SOURCE` 和 `TEAMHUB_SUPERAGENT_ADAPTER` 分别指向 Superagent 源码目录及本项目构建后的 `packages/dsh-plugin/lib/superagent-adapter.mjs`，使用该源码目录的 Vitest 运行 `vitest run --root <本仓库> --globals scripts/verify-superagent-contract.test.ts`。测试只创建临时目录和合成工单。

### 本机 Codex 与 Claude Code

[`stdio-executors.example.json`](../examples/adapters/stdio-executors.example.json) 演示如何通过 `cli-executor.mjs` 和 JSON-RPC stdio 注册 Codex、Claude Code。必须将 Node、各宿主程序、工作区和状态目录替换为本机绝对路径；每个执行器只允许其配置的实际工作区，可选择 `read-only` 或 `workspace-write`。Claude 的只读模式使用其 `plan` 权限、只启用 Read/Grep/Glob 内置工具并禁止加载已配置的 MCP 服务；实际权限及 hooks 仍受宿主自身配置约束，不应把本协议当作额外沙箱。

执行器使用独立监督进程及持久状态按 `dispatch_id` 找回；Codex 以 JSONL 的 `turn.completed`，Claude 以成功 JSON 结果确认运行成功。已固定共享能力版本的任务在启动前拒绝，避免声称安装了未安装的版本。取消只请求终止本机子进程，不能确认其完整进程树，结果可能为 `unknown`。Codex 和 Claude Code 均已用本机真实只读任务验证；网络需要代理的环境应在本机设置相应代理变量并按示例显式继承。OpenCode 目前使用标准 MCP/CLI 接入，尚未提供其自动执行适配器。
