# 其他 Harness 的真实宿主验证

## Windows 复验（2026-11-14）

使用 0.3.0 的 MCP 服务、生成的宿主配置和隔离演示 Hub，且不调用模型或修改现有宿主配置与正式台账：

| 宿主 | 测试版本 | 实测结果 |
| --- | --- | --- |
| Claude Code | 2.1.325 | `claude mcp list` 显示已连接；未通过该宿主调用业务工具 |
| Codex CLI | 0.167.0-alpha.4.1 | 发现 48 个工具（包括 `hub_integration_contract`）；临时线程实际调用只读 `hub_context` 成功 |

本次没有安装或运行 OpenCode。以上结果分别证明连接、工具发现和一次只读调用；其他宿主的看板及自动执行仍需要各自实现并验证适配器。

## Linux 验证（2026-11-13）

平台：Linux x64，Node.js 24.22.1。测试使用本仓库生成器输出的配置、同一套 Python MCP stdio 服务，以及独立演示 Hub。没有调用模型，没有读写用户 Windows 的配置、模型账户或正式台账。

## 实测结果

| 宿主 | 测试版本 | 生成配置由真实宿主读取 | MCP 连接 | 本次进一步检查 |
| --- | --- | --- | --- | --- |
| Claude Code | 2.1.323 | 项目 `.mcp.json`，通过 | 官方 `claude mcp list` 显示 `Connected` | 连接健康检查；未通过该宿主执行业务工具 |
| OpenCode V2 | 2.2.7 | 项目 `opencode.json`，通过 | 官方 `opencode mcp list` 显示 `connected` | 等待同一测试服务完成异步注册；未通过该宿主执行业务工具 |
| Codex CLI | 0.167.0-alpha.4 | 临时 `config.toml`，通过 | 官方 app-server 返回初始化后的 `serverCapabilities` | `mcpServerStatus/list` 实际发现 **30 个工具**，包括验收、能力发布和团队工具集 |

这些结果证明配置格式、进程启动和协议连接在对应版本上有效。`mcp list` 的成功不等于模型已经完成跨组业务任务。具体业务行为由独立的官方 MCP SDK → stdio → 真实 Hub 集成测试核验，见 [接入说明](../packages/INTEGRATION.md) 和 [验收记录](acceptance.md)。

OpenCode V1 配置格式依据官方迁移文档提供；**本次没有启动 V1 二进制**。其他平台、版本和用户自己的模型会话仍需要在实际环境验收。宿主原生待办和自动派发不在这次 MCP 连接测试的范围内。

## 复现

先按项目 README 安装 `.[mcp,dev]`。下面仅在独立目录下载测试用的官方 CLI，不做全局安装，也不改变现有宿主版本：

```bash
npm install --prefix /absolute/path/harness-test-runtime \
  --ignore-scripts --no-audit --no-fund \
  @anthropic-ai/claude-code@2.1.323 @opencode/cli@2.2.7

.venv/bin/python scripts/verify-harness-hosts.py \
  --runtime-dir /absolute/path/harness-test-runtime \
  --codex-binary /absolute/path/to/codex
```

`--runtime-dir` 自动定位 Linux x64 的官方可选原生二进制。其他平台或已有独立测试运行环境可直接提供：

```bash
.venv/bin/python scripts/verify-harness-hosts.py \
  --claude-binary /absolute/path/to/claude \
  --opencode-binary /absolute/path/to/opencode \
  --codex-binary /absolute/path/to/codex
```

可用 `--hosts claude opencode` 选择需要验证的宿主；`--output /new/path/result.json` 创建不含令牌的结果文件。当前目录必须可创建临时文件，所选 Python 必须已经安装本项目与 MCP extra。

脚本会：

1. 创建临时 Hub 数据目录和个人连接文件，使用明确的演示身份。
2. 通过 `teamhub.harness_config.render_config` 生成实际消费的配置；不手工复制测试模板。
3. 为 Claude Code、Codex 和 OpenCode 分别使用临时配置与数据目录，不继承模型凭据。
4. 在临时 Claude 用户配置中只批准这一个测试 MCP；用户原有项目的信任与权限设置不变。
5. 启动测试宿主并核验实际连接或工具清单，输出分层结果。
6. 关闭本次创建的进程，删除临时目录。

宿主配置只持有连接文件路径；令牌不写入项目 MCP 配置、不放进命令行参数，也不打印在验证报告里。

## OpenCode 冷启动行为

本次在 OpenCode 2.2.7 复现：`debug config` 已读到 `mcp.servers`，但一次性的 `mcp list --standalone` 可能在注册完成前返回 `No MCP servers configured`。官方仓库的 [#62902](https://github.com/anomalyco/opencode/issues/62902) 记录了同类现象。

验证脚本因此启动一个独立、仅监听回环地址且有临时密码的 `serve` 进程，通过 `--server` 重用该进程，并等待真实 `connected` 状态。最终本次运行在第 4 次状态查询时连接成功。空的第一次结果不会被计作成功，也不会据此改写正确的 MCP 配置。

## Codex 的工具调用检查边界

除 `mcp get` 配置读取外，脚本使用官方 app-server 的 `initialize`、`initialized` 和 `mcpServerStatus/list`，实际取得服务能力及工具定义。它没有调用 `turn/start`。

还提供可选 `--codex-tool-call`：创建临时线程后，通过官方 `mcpServer/tool/call` 调用只读的 `hub_context`。该方法及其参数来自当前 CLI 生成的协议 JSON Schema。

**2026-11-13 Linux 容器的这项额外检查没有通过**：创建线程时，容器内的 `bwrap` 无法创建 `NETLINK_ROUTE` socket，宿主在线程初始化阶段报权限错误。没有修改或关闭宿主沙箱来绕过它。2026-11-14 Windows 复验则成功调用 `hub_context`，结果见上文。可以单独复验：

```bash
.venv/bin/python scripts/verify-harness-hosts.py \
  --hosts codex --codex-binary /absolute/path/to/codex --codex-tool-call
```

## 配置依据

- [Claude Code MCP 文档](https://code.claude.com/docs/en/mcp)：`.mcp.json`、环境变量扩展、项目 MCP 审批与连接状态命令。
- [Codex MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)：`mcp_servers`、stdio 字段与 `env_vars`。
- [Codex app-server 文档](https://learn.chatgpt.com/docs/app-server)：初始化流程、MCP 状态与工具调用接口。
- [OpenCode MCP 文档](https://opencode.ai/docs/mcp-servers)：V2 `mcp.servers`、argv 数组、`environment` 与状态命令。
- [OpenCode V1 迁移文档](https://opencode.ai/docs/migrate-v1/)：V1 配置兼容与 V2 原生结构。
- [OpenCode Web/独立服务文档](https://opencode.ai/docs/cli/web/)：`serve`、`--server` 和 `OPENCODE_PASSWORD`。

这些外部文档用于核对配置与协议。以上“通过”结论来自本次实际执行，不是仅依据文档推断。
