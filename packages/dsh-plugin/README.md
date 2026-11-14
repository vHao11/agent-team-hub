# dsh-team-hub

Agent Team Hub 的 DSH 工具桥。使用官方 `defineTool` / `ctx.tools.register` 接口，注册 `teamhub_*` 工具。具体操作、安装和已验证范围见仓库 `packages/INTEGRATION.md`。

本包 0.5.1 提供并行流程回退、按成员和流程显式启用自动执行，以及 DSH 看板的受控业务操作。固定版本能力会在派发时自动安装并核验；Superagent 快照包含入口内容，供没有文件读取工具的任务使用。兼容支持停止状态接口的 Superagent，并在 DSH 受管资源退出后确认停止；当前进程范围证明仅支持经过校验的 Windows DSH 0.2.2-rc.1 本机提供器，旧版和无法核实的运行保持未知。隔离 DSH 0.2.2-rc.1 profile 已验证真实看板跨组流程；其他 DSH 版本和目标 profile 仍需各自验证。

```sh
node packages/dsh-plugin/build.mjs
cd packages/dsh-plugin
npm pack
dsh plugin --profile web add ./dsh-team-hub-0.5.1.tgz
dsh --profile web --dump-config
```

运行 DSH 前设置 `TEAMHUB_URL` / `TEAMHUB_TOKEN`，也可沿用本机 profile 的 `tokenFile` 配置。令牌从环境变量或该文件读取，不写入任务正文、同步状态或工具输出。安装新 bundle 后需要重启所选 profile。

插件通过 Cordis 服务探测兼容的 `dsh-todo-kanban`。用 `teamhub_pipeline_list` 查询流程，再调用 `teamhub_pipeline_link` 绑定；已有草稿可同时提供事项 ID 和草稿 ID。也可在本机设置 `adapterConfigFile` 并通过可选 `adapter` 参数选择其他看板；每个看板独立订阅并定期对账。未加载兼容看板时 `teamhub_status` 显示不可用。Superagent 适配器默认关闭，显式配置后受固定目录、请求大小和停止确认限制。通用协议及具体验证范围见仓库 `docs/adapter-protocol-v1.md`。

看板 0.8.2 及以上可在关联卡片打开 Hub 操作，按当前成员权限接单、更新进展、提交材料和审核。使用 `teamhub_pipeline_automation` 的 `enable` 为当前成员的某条流程选择执行器和工作区，`auto_accept` 只接收明确指定给本人的步骤；`disable` 停止后续自动派发。自动执行不会代替交付和验收。

增强插件可从 `dsh-team-hub/adapters` 导入 `adapters`，调用 `registerBoard` / `registerExecutor` 注册对自身公开 API 的封装。返回的 unregister 函数应接入该插件的实际卸载生命周期。此 registry 属于 Agent Team Hub，不是虚构的 DSH 原生服务。可参考仓库 `examples/adapters/register-known-host.mjs` 和 `packages/client/src/contracts.d.ts`。

安装 tarball 不执行构建脚本；构建产物已包括 HTTP 客户端，运行时无需下载未发布的 `@agent-team-hub/client`。SDK 保持 peer dependency，以共享宿主提供的实例。不要同时在同一 DSH 会话启用相同功能的 MCP 和原生工具，否则会形成两套重复工具入口。
