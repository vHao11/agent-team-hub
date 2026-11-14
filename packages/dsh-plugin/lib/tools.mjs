/** Tool shape follows DSH docs/user/develop/basic/tool.md at 0.2.2-rc.2. */
export function createToolDefinitions(defineTool, client, bridge, registry, boardSync = null, boardSyncFor = () => boardSync, autoDispatch = null) {
  const str = (description, required = true) => ({ type: 'string', ...(required ? { required: true } : {}), description });
  const num = (description, required = true) => ({ type: 'integer', ...(required ? { required: true } : {}), description });
  const item = { work_item_id: str('共享事项 ID。先通过查询获取，不使用标题或本地数组下标。') };
  const operation = { operation_id: str('调用方生成的稳定请求 ID；同一请求重试时重用。') };
  const version = { expected_version: num('最近读取的事项 version。冲突后读取新版本并核实修改。') };
  const data = { data_json: str('该命令的 JSON 对象；字段以 Agent Team Hub HTTP API 契约为准。') };
  const parse = value => {
    const result = JSON.parse(value);
    if (!result || Array.isArray(result) || typeof result !== 'object') throw new Error('data_json must be a JSON object');
    return result;
  };
  const make = (name, description, parameters, execute) => defineTool({ name: 'teamhub_' + name, description, parameters,
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args) { return JSON.stringify(await execute(args)); } });
  return [
    make('status', '读取当前 Hub 身份和本机桥接能力。没有适配器时 available=false；不能声称已接通看板或 Superagent。', {}, async () => ({
      context: await client.bootstrap(), client_instance_id: await bridge.instance(), adapters: await registry.probe(),
      ...(boardSync ? { board_sync: boardSync.lastResult } : {}),
      ...(autoDispatch ? { automation: autoDispatch.lastResult } : {}),
    })),
    make('integration_contract', '读取 Hub 通用接入协议版本与业务语义；不代表某个宿主适配器已经安装。', {}, () => client.integrationContract()),
    make('pipeline_list', '列出 Hub 流水线及步骤；只读取。', {}, () => client.listPipelines()),
    make('pipeline_get', '读取流水线步骤、当前轮次和关联事项。', { pipeline_id: str('Hub 流水线 ID。') }, args => client.getPipeline(args.pipeline_id)),
    make('pipeline_rollback', '回退指定步骤及依赖它的后续步骤；保留历史交付，受影响的运行必须先确认结束。', {
      pipeline_id: str('Hub 流水线 ID。'), step_key: str('要回退到的步骤标识。'), ...operation, ...version, reason: str('回退原因。'),
    }, args => client.rollbackPipeline(args.pipeline_id, args.step_key, { operation_id: args.operation_id, expected_version: args.expected_version, reason: args.reason })),
    make('pipeline_link', '把流水线关联到所选本机看板适配器；步骤激活后自动创建或复用卡片并同步业务状态。不会派单。', {
      pipeline_id: str('Hub 流水线 ID。'), workspace_ref: str('本机工作区定位字符串。'),
      work_item_id: str('可选：要关联已有草稿的流程事项 ID。', false), draft_id: str('可选：对应的已有看板草稿 ID。', false),
      adapter: str('可选：已注册的看板适配器名称；省略使用配置中的默认看板。', false),
    }, args => boardSyncFor(args.adapter).subscribe(args.pipeline_id, args.workspace_ref, { workItemId: args.work_item_id, draftId: args.draft_id })),
    make('pipeline_sync', '立即对账当前成员已关联的流水线；不执行工单或验收。', { adapter: str('可选看板适配器名称。', false) }, args => boardSyncFor(args.adapter).syncAll()),
    make('pipeline_unlink', '停止同步并移除该流程的 Hub 关联字段；保留看板本地草稿及其他本地内容。', {
      pipeline_id: str('已关联的 Hub 流水线 ID。'), adapter: str('可选看板适配器名称。', false),
    }, args => boardSyncFor(args.adapter).unsubscribe(args.pipeline_id)),
    ...(autoDispatch ? [make('pipeline_automation', '为当前成员显式启用或关闭单个流程的本机自动执行；只自动接收明确指定给本人的步骤，不自动验收。', {
      action: str('enable、disable、status 或 tick。'), pipeline_id: str('流程 ID；enable 和 disable 必填。', false),
      adapter: str('enable 时使用的执行器名称。', false), workspace_ref: str('enable 时执行器实际使用的工作区。', false),
      auto_accept: { type: 'boolean', description: '仅自动接单给当前成员的预指定步骤。' },
    }, args => {
      if (args.action === 'enable') return autoDispatch.enable(args);
      if (args.action === 'disable') return autoDispatch.disable(args.pipeline_id);
      if (args.action === 'status') return autoDispatch.lastResult;
      if (args.action === 'tick') return autoDispatch.tick();
      throw new Error('不支持的自动执行操作');
    })] : []),
    make('ledger_search', '查询共享跨组事项。只读取，不接单、不启动 Agent。', {
      view: str('all、mine、requested、review 或 inbox。', false), q: str('搜索词。', false), status: str('状态筛选。', false),
    }, args => client.listItems(args)),
    make('ledger_get', '读取事项目标、版本、验收条件、交付和运行记录。', item, args => client.getItem(args.work_item_id)),
    make('ledger_create', '按用户明确请求创建跨组事项。data_json 包含 title/project_id/target_team_id/acceptance_spec。', {
      ...operation, ...data,
    }, args => client.createItem({ ...parse(args.data_json), operation_id: args.operation_id })),
    ...['accept', 'start', 'progress'].map(action => make('ledger_' + action,
      action === 'accept' ? '按明确请求接单；不会启动本机 Agent。' : action === 'start' ? '登记人工开始处理；不会启动本机 Agent。' : '更新进度、阻塞原因或下一步；不会自动验收。',
      { ...item, ...operation, ...version, data_json: str(action === 'progress' ? '包含 summary，可选 blocked_reason/waiting_on/next_action。' : '可选 JSON 对象，accept 可以指定 assignee_id。', action === 'progress') },
      args => client.command(args.work_item_id, action, { ...(args.data_json ? parse(args.data_json) : {}), operation_id: args.operation_id, expected_version: args.expected_version }))),
    make('ledger_submit', '提交交付并等待验收。data_json 包含 spec_revision/summary/artifacts，可选 run_ids；共享 URL 不能为本机文件路径。', {
      ...item, ...operation, ...version, ...data,
    }, args => client.submitDelivery(args.work_item_id, { ...parse(args.data_json), operation_id: args.operation_id, expected_version: args.expected_version })),
    make('catalog_search', '搜索共享工具库，不会自动安装或执行工具。', { q: str('搜索词。', false), kind: str('skill、script、mcp、plugin、workflow 或 app。', false) }, args => client.listCapabilities(args)),
    make('catalog_resolve', '读取固定工具版本及 manifest/files，供用户检查后显式安装。', {
      capability_id: str('能力 ID。'), version: str('固定版本，例如 0.1.0；不接受 latest。'),
    }, args => client.getRelease(args.capability_id, args.version)),
    make('bind_session', '显式把已存在的本机会话或看板卡片绑定到共享事项。不能填写推测的会话 ID；不会启动或接管会话。', {
      ...item, ...operation, ...data,
    }, async args => client.bindItem(args.work_item_id, { ...parse(args.data_json), operation_id: args.operation_id,
      client_instance_id: await bridge.instance() })),
    make('board_link', '通过已注册且可用的 BoardAdapter 建立或复用本机卡片。缺失适配器时报 unsupported。', {
      ...item, ...operation, adapter: str('已注册的 BoardAdapter 名称。'), workspace_ref: str('本机工作区定位字符串。'),
    }, args => bridge.linkBoard(args.work_item_id, args)),
    make('run_start', '只有用户明确要求执行时才调用。能力探测成功后登记固定工具版本，通过 ExecutionAdapter 启动一次，绝不因重连重复启动。', {
      ...item, ...operation, ...version, adapter: str('已注册的 ExecutionAdapter 名称。'), workspace_ref: str('本机工作区定位字符串。'),
      capabilities_json: str('可选固定工具版本数组 [{capability_id,version}]；省略时由服务端解析该组工具集。', false),
      pipeline_attempt_id: str('流水线事项必须提供当前轮次 ID。', false),
      pipeline_generation: num('流水线事项必须提供当前流程 generation。', false),
    }, args => bridge.start(args.work_item_id, { ...args, ...(args.capabilities_json ? { capabilities: JSON.parse(args.capabilities_json) } : {}) })),
    make('run_register', '为现有外部会话登记运行记录；data_json 含 harness/workspace_ref/external_session_id，可选固定 capabilities。此调用不启动进程。', {
      ...item, ...operation, ...version, ...data,
    }, async args => client.createRun(args.work_item_id, { ...parse(args.data_json), operation_id: args.operation_id,
      expected_version: args.expected_version, client_instance_id: await bridge.instance() })),
    make('run_report', '回传已核实的本机运行状态。data_json 必须含单调递增 sequence/status，可含 external_session_id/summary；运行成功不代表事项验收。', {
      run_id: str('共享运行 ID。'), ...operation, ...data,
    }, async args => client.reportRun(args.run_id, { ...parse(args.data_json), operation_id: args.operation_id, client_instance_id: await bridge.instance() })),
    make('run_reconcile', '查询已有外部会话并回传状态；找不到会话时保持待核实，不重新启动。', {
      dispatch_id: str('run_start 返回的 dispatch_id。'),
    }, args => bridge.reconcile(args.dispatch_id)),
    make('run_cancel', '对已登记的本机执行请求取消。只有适配器明确确认停止后才回传 cancelled。', {
      dispatch_id: str('本机 dispatch_id。'), ...operation,
    }, args => bridge.cancel(args.dispatch_id, args.operation_id)),
  ];
}
