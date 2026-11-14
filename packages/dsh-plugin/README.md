# dsh-team-hub

Agent Team Hub 的 DSH 工具桥。使用官方 `defineTool` / `ctx.tools.register` 接口，注册 `teamhub_*` 工具。具体操作、安装和已验证范围见仓库 `packages/INTEGRATION.md`。

本包 0.3.0 在 Windows 的隔离 **DSH 0.2.2-rc.1** profile 中完成宿主加载，并与真实 `dsh-todo-kanban`、独立 Python 看板完成跨组流程验证；原版 0.1.0 曾在 Linux 官方 rc.1 和 rc.2 中通过宿主加载验证。0.3.0 的 rc.2 与正式 profile 仍需分别验证。SDK 开发依赖固定 rc.2；测试未调用模型或启动真实 Superagent 执行器。

```sh
node packages/dsh-plugin/build.mjs
cd packages/dsh-plugin
npm pack
dsh plugin --profile web add ./dsh-team-hub-0.3.0.tgz
dsh --profile web --dump-config
```

运行 DSH 前设置 `TEAMHUB_URL` / `TEAMHUB_TOKEN`，也可沿用本机 profile 的 `tokenFile` 配置。令牌从环境变量或该文件读取，不写入任务正文、同步状态或工具输出。安装新 bundle 后需要重启所选 profile。

插件通过 Cordis 服务探测兼容的 `dsh-todo-kanban`。用 `teamhub_pipeline_list` 查询流程，再调用 `teamhub_pipeline_link` 绑定；已有草稿可同时提供事项 ID 和草稿 ID。也可在本机设置 `adapterConfigFile` 并通过可选 `adapter` 参数选择其他看板；每个看板独立订阅并定期对账。未加载兼容看板时 `teamhub_status` 显示不可用。Superagent 适配器默认关闭，显式配置后受固定目录、固定工具版本和停止确认限制。通用协议及具体验证范围见仓库 `docs/adapter-protocol-v1.md`。

增强插件可从 `dsh-team-hub/adapters` 导入 `adapters`，调用 `registerBoard` / `registerExecutor` 注册对自身公开 API 的封装。返回的 unregister 函数应接入该插件的实际卸载生命周期。此 registry 属于 Agent Team Hub，不是虚构的 DSH 原生服务。可参考仓库 `examples/adapters/register-known-host.mjs` 和 `packages/client/src/contracts.d.ts`。

安装 tarball 不执行构建脚本；构建产物已包括 HTTP 客户端，运行时无需下载未发布的 `@agent-team-hub/client`。SDK 保持 peer dependency，以共享宿主提供的实例。不要同时在同一 DSH 会话启用相同功能的 MCP 和原生工具，否则会形成两套重复工具入口。
