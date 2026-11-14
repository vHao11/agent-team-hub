# 参与开发

本仓库使用 MIT 许可证，贡献代码沿用相同许可证。当前为 0.2.x，优先完善 DSH 适配和团队协作中的可恢复行为。

## 本地工作

按照 README 安装 `.[mcp,dev]` 和 web 的 npm 依赖。使用独立演示目录运行服务，不把数据目录、令牌、个人日志或真实交付附件提交到 Git。

前端变更运行 `npm run build`；领域/API 变更运行 `python -m pytest tests`；客户端和插件变更运行 packages/INTEGRATION.md 中对应测试。

GitHub Actions 已配置 Linux/Windows 的 Python 测试与前端、Node、DSH SDK 检查。工作流首次在你的远程仓库运行后，才构成该仓库实际平台验证记录；当前交付的本地结果见 docs/acceptance.md。

## 应保持的边界

- WorkItem 状态由领域命令维护；Run 回报不能直接通过业务验收。
- 身份来自服务端 Bearer 令牌解析，客户端不能自行提交 actor_id 取得其他身份。
- 幂等回执、领域变更和事件在同一短事务提交。执行网络调用和本地进程不进入数据库事务。
- 每次执行保留不可变输入和能力版本；同步事件不自动触发执行。
- 适配器必须调用已存在且明确的宿主 API。探测失败应返回不支持，禁止用模拟成功掩盖接口缺失。
- DSH、看板与 Superagent 的版本约束应来自实际源码或 SDK 检查；改变约束时提交相应验证证据。

## 建议的首批贡献

1. 扩充个人待办看板的状态同步和异常恢复验证。
2. 对接增强 Superagent 的显式派发、dispatch_id 查询、状态与取消确认。
3. 在真实 Windows DSH profile 验证多团队、多身份的完整协作事项验收。
4. 改善能力发布表单和包导入体验，保持版本不可覆盖。

提交 PR 时说明具体问题、变更后的行为、验证方法和仍未确认的环境。更改 HTTP 契约时同步 docs/implementation-contract.md 和对应客户端。
