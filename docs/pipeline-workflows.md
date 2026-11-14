# 流水线：并行、回退和接入

流水线由有向无环图中的工作步骤组成。每个步骤创建一个普通协作事项；没有前置依赖的步骤可并行激活，所有前置步骤的交付均通过指定验收后才激活后续步骤。汇合步骤的固定输入包含各前置交付快照。已有事项、交付、审核和 Run 仍是事实记录；执行成功本身不会触发验收。

## 在 Web 中操作

1. 团队负责人或管理员进入“流水线模板”，设置团队／验收角色、步骤依赖、验收标准和必需材料类型。保存草稿，校验并发布。未选前置步骤代表可并行开始。
2. 从已发布版本创建流水线，选择项目，为每个角色绑定团队或验收账号；也可以为步骤预选承接团队的处理人。创建后为草稿，确认后点击“启动流水线”。
3. 承接团队在“团队收件箱”接单并处理，在事项详情中提交满足类型要求的材料。承接前责任仍在发起团队；拒收后发起人可以重新指派团队。
4. 具名验收账号在事项详情或已关联看板中通过或要求修改。要求修改生成新的步骤轮次；所有依赖通过后，下一组收到新的协作事项，并可查看各前置交付快照。全部步骤通过后流程完成。
5. 发起人、发起团队负责人或管理员可以暂停、恢复或取消未结束的流程。暂停时不能开始新处理或登记新执行，已进行的交付和验收可以继续；验收通过后要等恢复才会激活下一步骤。取消会关闭当前事项，并对尚未结束的 Run 发出停止请求，是否真正停止由执行方确认。

模板发布后，发布版本及其定义不可修改。复制最新版本为新草稿并重新发布，不会改变已经创建的流程。步骤处理人与验收人必须为不同账号；当前权限模型无法证明具名账号的操作一定是由人发出，MCP 客户端应自行安排人工确认。

流程发起人、发起组负责人或管理员可在流程详情中选择目标步骤并填写原因执行回退。目标和所有依赖它的后续步骤重新开始，互不依赖的分支保留结果；历史事项、交付和轮次仍可查看，旧看板卡片标为失效。受影响步骤有运行中、取消未确认或状态未知的 Run 时必须先核实并结束，不能强行覆盖；已完成的流程也可以回退。

模板步骤的 `depends_on` 是前置步骤 key 的数组：`[]` 表示无依赖；有多个 key 时表示全部验收通过后激活。为兼容旧模板，省略字段或使用 `null` 时沿用旧串行规则（首步骤无依赖，其余依赖前一个步骤）。校验拒绝不存在的 key、重复依赖、自依赖和环。

## HTTP 和 MCP

HTTP 基础路径为 `/api/v1`，交互文档为服务的 `/docs`。创建与修改操作需要 Bearer 身份、唯一 `operation_id`；带乐观并发控制的操作还需要当前的 `expected_version` 或模板 `expected_revision`。网络重试同一操作复用原 `operation_id`；业务内容变化则使用新编号。

一个可发布的两步模板定义示例：

```json
{
  "roles": [
    {"key": "implementation", "label": "实施团队", "kind": "team"},
    {"key": "testing", "label": "测试团队", "kind": "team"},
    {"key": "reviewer", "label": "验收人", "kind": "reviewer"}
  ],
  "steps": [
    {
      "key": "implement", "name": "实施", "team_role": "implementation",
      "reviewer_role": "reviewer", "acceptance_spec": ["提交实施说明"],
      "required_artifact_kinds": ["document"], "depends_on": []
    },
    {
      "key": "test", "name": "验证", "team_role": "testing",
      "reviewer_role": "reviewer", "acceptance_spec": ["提交验证报告"],
      "required_artifact_kinds": ["report"], "depends_on": ["implement"]
    }
  ]
}
```

创建模板时将上述对象作为 `definition`，随 `name`、`description` 和 `operation_id` 发送到 `POST /workflow-templates`。`POST /workflow-templates/{id}/validate` 校验草稿；`POST /workflow-templates/{id}/publish` 使用 `expected_revision` 发布，并返回模板版本 ID。复制修改使用 `/clone` 后 `PUT /workflow-templates/{id}`。

使用返回的 `template_version_id` 和各角色映射创建流程，例如 `role_bindings` 为 `{"implementation":"<团队 ID>","testing":"<团队 ID>","reviewer":"<成员 ID>"}`；`assignees` 可将步骤 key 映射到该团队成员 ID。`POST /pipelines` 还需要 `title`、`project_id`、`operation_id`，返回包含 `pipeline`、`steps` 的视图。`POST /pipelines/{id}/start` 使用当前流程 `version` 启动；同路径下还可执行 `pause`、`resume` 或 `cancel`。拒收后调用 `POST /pipelines/{id}/steps/{step_key}/reassign`，包含 `target_team_id`、`reason`、当前流程 `expected_version` 和 `operation_id`。

回退使用 `POST /pipelines/{id}/steps/{step_key}/rollback`，请求包括 `operation_id`、当前流程 `expected_version` 和 `reason`。冲突后重新读取并确认；重试同一操作保留原 `operation_id`。MCP 使用 `pipeline_rollback`，DSH 使用 `teamhub_pipeline_rollback`，CLI 使用 `pipelines rollback`。

对关联事项调用接单、开工、交付、审核、转交、绑定或登记 Run 之前，读取 `GET /work-items/{id}` 的 `pipeline_context`，并在写入中附带：

```json
{
  "pipeline_attempt_id": "<pipeline_context.attempt_id>",
  "pipeline_generation": 1
}
```

数值必须使用读取结果中的 `generation`。事项写入还需携带事项当前 `expected_version`；交付还需当前 `spec_revision`。刷新后再处理冲突，不要沿用被退回的轮次或其它流程代次。新的交付仅能引用本轮 Run；每个步骤的能力版本取模板显式固定版本，否则在步骤激活时固定承接团队工具集。步骤接收前重新指派时，未显式固定的能力版本按新团队重新固定。上传的新附件记录 SHA-256；外部链接由相应外部系统管理。

MCP 提供 `workflow_template_*`、`pipeline_list/get/create/control/reassign/rollback` 和 `pipeline_step_command/submit/review/run_register/bind_session`。这些工具调用同一套 HTTP 规则。DSH 原生工具也可查询、回退和关联流水线。

## 关联 DSH 待办看板

双向操作需要 Hub 0.4.0、`dsh-team-hub` 0.4.0 和 `dsh-todo-kanban` 0.8.2 或更新版本。旧看板仍可接收兼容快照。三个组件可以先在隔离环境验证；更新已有服务和 profile 应先备份，按本机工作台的停机、安装及重启流程操作。令牌继续使用 profile 中配置的 `tokenFile` 或进程环境，不放入看板和任务正文。

1. 在 DSH 中调用 `teamhub_status`，确认当前成员与 `dsh-todo-kanban` 适配器可用；调用 `teamhub_pipeline_list` 查找流水线。
2. 调用 `teamhub_pipeline_link`，传入 `pipeline_id` 和本机 `workspace_ref`。若绑定现有草稿，同时传入该流程的 `work_item_id` 和看板 `draft_id`；二者必须同时提供。
3. 插件在当前 DSH profile 内按成员和 Hub 地址保存订阅，每 15 秒对账；也可调用 `teamhub_pipeline_sync` 立即刷新。后续步骤激活时，为当前成员有权限关联的事项创建或复用草稿。`teamhub_pipeline_unlink` 停止订阅并移除关联字段，保留草稿的本地内容。

外部键由 Hub 地址和事项 ID 构成。看板首次关联前保存一份 `board.before-team-hub-v1.json`；随后状态同步只更新独立的 Hub 快照，不覆盖本地标题、正文、标签、优先级和备注。绑定或响应丢失后重新对账会复用同一卡片；版本倒退或无法识别的关联会拒绝自动覆盖并报告错误。订阅文件不含令牌。各 profile 应使用各自成员身份，不将一个 profile 作为多成员身份代理。

| Hub 事项／流程状态 | 未派单关联草稿在看板中的展示 |
| --- | --- |
| 待接单、已接单 | 待办；拒收后等待重新安排 |
| 处理中 | 进行中；流程暂停时显示在等待外部 |
| 待验收 | 待人工 |
| 已验收、已取消 | 已完成、已搁置 |

已关联但此前已派成 Superagent 工单的草稿，工单仍由 Superagent 状态决定所在列，Hub 业务状态作为独立标签展示。关联中的草稿暂不支持从看板派单或删除；先解除关联后，保留的本地草稿可以继续按原规则使用。看板的 Hub 操作面板按当前成员权限显示接单、拒收、开工、进度、交付和审核；每项操作提交明确命令，并由 Hub 验证成员、当前版本和轮次。拖动列或 Superagent 完成不会自动完成 Hub 事项。写入成功后同步暂时失败时显示待同步，不重复执行成功的业务命令。

## 按流程启用自动派发

DSH 中先配置并探测执行器，再调用 `teamhub_pipeline_automation`，以 `action: "enable"`、`pipeline_id`、`adapter`、`workspace_ref` 启用当前成员的该流程。`auto_accept: true` 只接收模板任务中明确指定给当前成员的步骤；该成员已接收的当前轮次可自动启动并对账。`action: "disable"` 停止后续自动派发，`status` 查看状态，`tick` 立即执行一次对账。插件正常运行时会按配置间隔检查。

其他宿主可使用 CLI `automation enable <流程ID> --adapter <名称> --workspace-ref <工作区> --adapter-config <本机配置> [--auto-accept]`，再运行 `automation run --adapter-config <本机配置>`；`tick` 单次执行，`disable <流程ID>` 关闭。启用记录只保存在本机并按 Hub、成员和流程隔离。已存在当前轮次 Run（包括失败或未知）不会自动重派；Run 成功不会自动提交或验收。执行器启动、找回和停止能力以实际声明为准，见 [适配协议](adapter-protocol-v1.md)。

## 老数据与升级

服务启动时依次执行所需的数据库迁移，目前支持 v1 → v2；未知较新版本会拒绝启动，避免误写。升级不重建旧事项、交付、Run 或附件，旧事项不要求流水线上下文字段；v1 附件的哈希为空，不会改写其内容。实际升级前先运行：

```powershell
.venv\Scripts\python.exe -m teamhub backup --data-dir .\.teamhub --output .\backups\before-pipeline-v2.zip
```

升级和写入 v2 数据后，旧程序不支持读取 v2；需要回退时停止服务，将升级前备份解压到新目录，并用旧版本指向该目录。若升级后产生新业务数据，它们不在升级前备份里。

0.4.0 继续使用数据库 schema 2，不需要为并行和回退重建旧数据；旧模板省略依赖字段时维持原有串行行为。升级前仍应备份并在副本上验证。
