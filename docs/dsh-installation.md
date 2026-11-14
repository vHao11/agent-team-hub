# Windows 安装到现有 DSH

安装入口会安装 Hub 的 Python 依赖、初始化或复用数据目录、启动或复用本机 Hub 服务、验证当前身份、向指定的现有 DSH profile 安装插件，并保存连接设置。

## 使用

解压完整发行 ZIP 后，在项目目录执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-dsh.ps1 -DshPath "C:\path\to\dsh.cmd" -Profile web
```

路径仅示例，应使用当前实际 DSH 启动器。省略 DshPath 时使用当前 PATH 解析到的 dsh.cmd。曾安装过多个 DSH 的电脑建议填写绝对路径。DSH_HOME 按参数、当前环境变量、用户目录下 .dsh 的顺序确定；目标 profiles/web/package.json 必须已存在。

可用参数：

| 参数 | 用途 |
|---|---|
| DshPath | 指定已经安装的 DSH 启动器 |
| Profile | 已存在的 profile，默认 web；DshProfile 是同义参数名 |
| DshHome | 明确指定现有 DSH_HOME |
| DataDir | Hub 数据目录，默认项目下 .teamhub |
| Port | 本机端口，默认 8765 |
| Python | 用于创建虚拟环境的 Python 命令或完整路径 |
| Token | 连接已有正式数据目录时提供现有成员令牌；也可使用 TEAMHUB_TOKEN 环境变量 |
| Demo | 显式使用演示身份和独立 .teamhub-demo 目录 |

脚本根据插件 manifest 检查 DSH 版本，并要求 Node.js 24.9+、Python 3.11+ 与 pnpm。依赖不满足时会给出具体错误；不会升级现有 DSH。

## 保存与验证

正式工作空间首次初始化生成的令牌保存在数据目录的 install-connection.json。重复执行会复用同一身份；已有数据目录缺少可用令牌时需提供当前令牌，不重置用户。

插件连接配置写入 DSH_HOME/.env 的 TEAMHUB_URL、TEAMHUB_TOKEN，仅这两个键会更新。其余配置内容保留，原文件另存备份。当前安装进程也设置相同变量以便验证；后续启动时已有进程环境变量或项目目录 .env 的同名值仍可能覆盖 DSH_HOME/.env。

完成后检查数据目录里的 install-report.json。报告包括路径、版本、profile、服务状态和配置检查结果，不包含令牌。脚本不会终止已有 DSH 进程；在适当时机重启同一 profile 后，在 DSH 调用 teamhub_status 完成运行时工具验证。

Hub 服务在后台运行，日志位于数据目录的 logs/。重启电脑后可再次运行本安装入口，或运行原来的 scripts/start.ps1 启动同一数据目录。

## 当前验证范围

Python 安装辅助逻辑已在 Linux 验证正式身份复用、环境文件保留、真实 HTTP 服务启动/复用与身份检查。Windows PowerShell 入口尚未在用户 Windows 机器执行。安装报告的 config_verified 仅表示配置合成通过，runtime_tool_verified 保持 false，直到实际宿主会话验证成功。
