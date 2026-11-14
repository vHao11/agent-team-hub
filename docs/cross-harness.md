# 不依赖 DSH 的接入与共享工具使用

Agent Team Hub 的业务服务不依赖 DSH。团队可以共用一个 Hub，成员分别使用 DSH、Claude Code、Codex、OpenCode 或其他客户端，通过各自的 MCP/CLI 入口操作同一份台账和工具库。

DSH 原生插件是其中一个客户端。跨组事项、交付、审核、成员身份、运行记录与能力版本都保存在独立 Hub 中，不需要经过 DSH 转发。MCP 进程只访问 Hub 的带认证 HTTP API，不打开服务端数据库。

## 1. 先启动 Hub

任何客户端都需要一个可访问的 Hub。已有团队服务时，直接使用该服务的 URL 和分配给自己的成员令牌；无需为每个 harness 再启动一个数据库。

在本机体验：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start.ps1 -Demo
```

Linux/macOS 使用 `bash scripts/start.sh --demo`。演示身份仅适用于显式演示空间。正式工作空间的创建和成员配置见主 README。

MCP 客户端所在机器需要 Python 3.11+，在项目目录安装一次：

```powershell
python -m venv .venv
.venv\Scripts\python.exe -m pip install -c constraints-tested.txt -e ".[mcp]"
```

Linux/macOS 将 Python 路径替换成 `.venv/bin/python`。源码 ZIP 已含预构建 Web，无需构建前端才能接入。仅使用 MCP 不要求 Node 或 DSH；运行 Node CLI、安装 Skill 和运行共享脚本时需要 Node 22+。

## 2. 生成正确的宿主配置

不要把一个宿主的 MCP JSON 原样复制到另一个宿主。生成器会使用实际 Python 绝对路径，并按宿主的格式输出配置片段。

在将要启动 harness 的终端设置成员身份：

```powershell
$env:TEAMHUB_TOKEN = "<当前成员令牌>"
.venv\Scripts\python.exe -m teamhub.harness_config --harness claude-code --url http://127.0.0.1:8765 --output teamhub-mcp.fragment.json
```

将生成的片段合入对应文件。新项目没有该文件时，可以直接把 `--output` 指向它；已有文件不会被生成器覆盖。配置中只有环境变量引用，不会展开、输出或保存终端中的令牌值。启动宿主的进程需要继承该变量；从另一个终端或桌面启动时应使用下面的连接文件模式。

| harness 参数 | 宿主配置位置 | 生成结构 | 连接检查 |
| --- | --- | --- | --- |
| `claude-code` | 项目 `.mcp.json` | `mcpServers.agent-team-hub`，command + args | `claude mcp get agent-team-hub` |
| `codex` | 用户 `~/.codex/config.toml`，或受信任项目 `.codex/config.toml` | `[mcp_servers.agent-team-hub]`，`env_vars` | `codex mcp get agent-team-hub` 只检查配置；实际会话工具或 app-server 状态再确认连接 |
| `opencode` | 项目 `opencode.json` / `opencode.jsonc` | V2 的 `mcp.servers.agent-team-hub`，argv 数组 | `opencode mcp list` |
| `opencode-v1` | V1 项目 `opencode.json` / `opencode.jsonc` | V1 的 `mcp.agent-team-hub` | 在实际 V1 版本中运行 `opencode mcp list` |
| `generic` | 宿主声明支持的 `mcpServers` 文件 | command + args，必须指定连接文件 | 宿主连接检查并调用 `hub_context` |

Claude Code 首次使用项目 `.mcp.json` 时可能显示宿主自己的项目服务器确认；按该宿主界面完成。不要把 `Pending approval` 当成已连接。这里不改变宿主的工具权限设置。

Windows 配置直接启动绝对路径 `python.exe`，不会通过 `cmd /c` 拼接命令；路径中的中文和空格作为独立 argv 处理。向其他机器生成配置时可显式传 `--python`，例如：

```powershell
$teamhubPython = (Resolve-Path -LiteralPath '.\.venv\Scripts\python.exe').Path
.venv\Scripts\python.exe -m teamhub.harness_config --harness codex --python $teamhubPython --output teamhub-mcp.fragment.toml
```

可审查的静态示例位于 `examples/mcp/`。这些示例中的 `D:\path` 必须替换；生成器可以避免手工改路径。

### 可选：使用一份本机连接文件

对于桌面启动、多个宿主共用身份，或者不支持环境变量展开的 MCP 客户端，可以提供一份私有 JSON：

```json
{
  "url": "http://127.0.0.1:8765",
  "token": "<当前成员令牌>"
}
```

文件放在自己的配置或数据目录，作为本机凭据保管，不加入公共仓库。已经运行本项目 Windows DSH 安装器时，可复用数据目录里的 `install-connection.json`；没有 DSH 也可以自行创建同格式文件。

```powershell
.venv\Scripts\python.exe -m teamhub.harness_config --harness generic --connection-file "D:\private\teamhub-connection.json" --output teamhub-mcp.fragment.json
```

其他三个宿主同样支持该参数。生成器只记录文件路径，MCP 启动后读取文件中的 URL 与令牌。连接文件中的两者作为一对使用，优先于继承的 `TEAMHUB_URL/TEAMHUB_TOKEN`，避免旧环境变量改变该凭据的目标服务。也可手动以 `TEAMHUB_CONNECTION_FILE` 指定文件。

## 3. 通过 MCP 完成整个协作流程

连接后先调用 `hub_context`，读取实际成员、团队、项目 ID，再根据真实请求操作台账：

1. 发起人在自己的 harness 调用 `ledger_create`，给出目标团队、验收人和验收条件。
2. 承接人在另一个 harness 调用 `ledger_search`、`ledger_get`、`ledger_accept`，再开工、记录进展或卡点。
3. 需要记录 Agent 执行时调用 `hub_run_register`，实际工作仍由当前 harness 执行，再用 `hub_run_report` 回传核实过的状态。
4. 交付时用 `artifact_upload_text` 上传 UTF-8 报告，得到共享 `artifact://...`，然后调用 `ledger_submit` 提交具体交付版本。
5. 指定验收人在自己的 harness 调用 `artifact_read_text` 阅读材料，再通过 `ledger_review` 明确通过或退回。

每个成员使用自己的令牌。每次变更以刚读到的 `expected_version` 为准；重试同一操作保留原来的 `operation_id`。Run 成功后事项仍需提交交付并通过验收。

MCP 同时提供拒绝、取消事项、转交和接受转交、修改验收条件、增加依赖、Run 取消请求、增量事件、能力发布和团队工具集。文本附件工具有明确的大小与 UTF-8 限制；二进制附件通过 Web/CLI 上传。附件上传没有业务操作 ID，不确定上传结果时检查已有返回或重新上传后只引用实际返回的附件。

台账的 `start` 和 `run_register` 都不会创建新的 Agent 进程。Run 的取消请求需要实际执行方停止工作并回报；不会仅凭业务请求声明宿主已经停止。

## 4. 共享 Skill、脚本和团队工具集

### Skill 安装到项目发现目录

先查询要使用的能力和固定版本，然后明确指定宿主与已存在的代码项目目录：

```powershell
$env:TEAMHUB_URL = "http://127.0.0.1:8765"
$env:TEAMHUB_TOKEN = "<当前成员令牌>"
node packages/cli/bin/teamhub.mjs tools list --kind skill
node packages/cli/bin/teamhub.mjs tools install <CAPABILITY_ID> --version 0.1.0 --harness claude-code --workspace "D:\projects\trading-service"
```

| `--harness` | 项目内安装位置 |
| --- | --- |
| `claude-code` | `.claude/skills/<名称>/SKILL.md` |
| `codex` | `.agents/skills/<名称>/SKILL.md` |
| `opencode` | `.opencode/skills/<名称>/SKILL.md` |

目录名称由 capability.slug 的命名空间斜杠转换为短横线，例如 `trading/interface-review` → `trading-interface-review`。Skill 必须具有匹配的 `name` 与非空 `description`，缺少元数据或类型不符会给出错误。宿主安装模式只接受 Skill；脚本用下面的明确目录模式。

安装不会执行包里的代码。重复安装同一发布版本会复用目录；不同版本不会覆盖正在使用的版本。升级时由使用者在合适时机移走旧目录，再安装新版本。安装位置正确不等于某个已打开的宿主会话已重新发现 Skill；按该宿主的加载规则重新打开项目并检查。

此前已初始化的演示空间可能保留旧 `0.1.0` 示例 Skill 名称；发布版本不可变，重启不会改写它。如果遇到 `SKILL_NAME_MISMATCH`，可用新的演示数据目录体验当前样例，或为已有能力发布具有匹配名称的新版本；旧包仍可通过 `--directory` 明确选择目录使用。

### 脚本使用通用目录与显式运行

```powershell
node packages/cli/bin/teamhub.mjs tools install <CAPABILITY_ID> --version 0.1.0 --directory "D:\team-tools\log-summary\0.1.0"
node packages/cli/bin/teamhub.mjs tools run "D:\team-tools\log-summary\0.1.0" -- --file "D:\logs\session.jsonl"
```

具备终端能力的 harness 都可以执行这两步。Python/Node 是当前脚本运行时，按需安装依赖；安装与执行是两个明确动作。仅有 MCP 访问、没有本地终端或文件能力的客户端可以读取发布内容和维护台账，不因此获得本机脚本执行能力。

通过 `team_toolset_get/set` 或 CLI `toolsets get/set` 维护团队固定版本工具集。Run 登记时由服务端把该次使用的版本冻结在运行记录中；运行中的版本不会随工具集更新改变。首版不会后台推送并强制升级每个成员的本机 Skill。

`mcp/plugin/workflow/app` 类型现在支持目录、manifest 和版本资料发布；任意第三方 MCP 的自动安装、跨宿主插件移植、工作流执行器及应用部署不在当前实现范围。

## 5. 兼容性与实际验证

标准 MCP 握手成功只说明协议接通；完整业务测试还需要验证身份、实际 HTTP 请求、交付和验收。真实宿主验证还需要宿主确实加载生成配置并连接本项目 MCP。

对应结果记录在 [宿主验证记录](harness-host-verification.md)，MCP-only 双身份业务测试为 `packages/integration/test_mcp_workflow.py`。DSH 的两版官方宿主记录单独保留在 [DSH 安装验证](dsh-installation-verification.md)。

通用适配器协议支持进程内 Node 接口及跨语言 JSON-RPC stdio，可将其他看板和执行器接入同一客户端，详见 [通用接入协议 v1](adapter-protocol-v1.md)。自动启动、取消和恢复特定 Harness 仍需要该宿主的真实 `ExecutionAdapter`；通用 MCP 可用不会被写成这些适配已经完成。已有 0.2.0 正式 DSH 看板联动记录；0.3.0 正式 profile 尚未切换。

## 官方格式依据

以下页面在 2026-11-13 核对，实际验证版本以宿主验证记录为准：

- [Claude Code MCP](https://code.claude.com/docs/en/mcp) 与 [Skills](https://code.claude.com/docs/en/skills)。
- [Codex MCP](https://developers.openai.com/codex/mcp) 与 [Build skills](https://learn.chatgpt.com/docs/build-skills)。
- [OpenCode MCP](https://opencode.ai/docs/mcp-servers) 与 [Skills](https://opencode.ai/docs/skills)。

OpenCode 已有 V1/V2 配置差异；生成新配置默认选择 V2，继续使用 V1 时明确选择 `opencode-v1`。
