# DSH 插件安装与实际宿主验证

## 验证结论与范围

2026-11-12，在独立 Linux 环境中，`dsh-team-hub@0.1.0` 已通过官方 DSH **0.2.2-rc.1** 与 **0.2.2-rc.2** 的真实宿主加载检查。两版均使用 npm 官方发布包、Node.js **24.22.1**、pnpm **10.34.9**，不依赖测试替身来模拟 DSH 的工具服务。

| 检查 | 0.2.2-rc.1 | 0.2.2-rc.2 |
| --- | --- | --- |
| 精确官方 CLI 版本 | 通过 | 通过 |
| 在临时 `DSH_HOME` 内执行 `plugin --profile web add` 安装实际 tgz | 通过 | 通过 |
| `--profile web --dump-config` 合成插件层 | 通过 | 通过 |
| 官方 Web profile 完整启动 | 通过 | 通过 |
| `ctx.tools.definitions()` 中唯一 `teamhub_*` 工具 | 17 个 | 17 个 |
| 从真实注册表取得 `teamhub_status` 并调用，访问本机 Hub | 身份 `u-lin` | 身份 `u-lin` |
| 从真实注册表取得 `teamhub_catalog_search` 并调用 | 1 个脚本能力 | 1 个脚本能力 |
| 默认看板 / 执行器适配器数量 | 0 / 0 | 0 / 0 |
| 宿主与 Hub 关闭 | 正常 | 正常 |

最终交付 tgz 已用仓库附带的复现脚本在两版宿主各重新安装验证。该文件的 SHA-256 为 `f243b2558ea31d5e9069aebc8d604fd447a12204ae8e8d33ee7673dea8c5bb52`；同轮 21 项 Node 契约测试全部通过。

该检查启动真实宿主并直接执行注册工具的 `execute` 方法，没有提交模型对话，也没有启动 Superagent。它验证 bundle 的加载、工具注册、参数处理和 HTTP 访问链路；未覆盖模型自动选工具、用户自定义插件组合、用户 Windows 启动器或增强 Superagent。

**用户电脑上的安装仍需要运行安装器并重启目标 profile。** 此处临时 profile 的成功不代表已经写入用户的 D 盘或正在使用的 DSH 配置。

根据实际结果，manifest 采用精确的已验证范围：

```json
{
  "engines": { "node": ">=24.9.0", "dsh": "0.2.2-rc.1 || 0.2.2-rc.2" },
  "peerDependencies": { "@deepseek-ai/dsh-tools": "0.2.2-rc.1 || 0.2.2-rc.2" }
}
```

开发依赖仍固定 `@deepseek-ai/dsh-tools@0.2.2-rc.2`，其他宿主版本未经本次验证。没有为了安装本插件而升级用户已有宿主或改动增强 Superagent。

## 在独立环境复现

先安装本项目 Python 依赖并准备 Node.js 24.9+、npm。发布 ZIP 已附带 tgz；源码检出可在 `packages/dsh-plugin` 中执行 `npm pack --pack-destination dist` 生成它。

在仓库根目录运行：

```bash
.venv/bin/python scripts/verify-dsh-host.py --version 0.2.2-rc.1
.venv/bin/python scripts/verify-dsh-host.py --version 0.2.2-rc.2
```

Windows Python 入口通常为 `.venv\Scripts\python.exe`。验证脚本中的 Windows 分支尚未在 Windows 实机执行；本次证据来自 Linux。

脚本将 npm 官方宿主和 pnpm 安装到新临时目录，并为每次运行分别分配 `DSH_HOME`、`DSH_AGENTS_HOME`、Hub SQLite 数据目录和桥接状态目录。它只继承运行与网络所需的环境变量，不继承模型 API 凭据；使用公开演示身份 `demo-lin`，两个服务均只监听 `127.0.0.1`。输出会屏蔽 DSH 启动 URL 中的临时 token，最终返回 JSON 检查结果与被测 tarball 的 SHA-256。退出时关闭进程并清理临时目录。

如已单独安装测试运行时，可避免重复下载：

```bash
.venv/bin/python scripts/verify-dsh-host.py --version 0.2.2-rc.2 --runtime-dir /absolute/path/to/independent-test-runtime
```

`--runtime-dir` 指向包含 `node_modules/@deepseek-ai/dsh` 的独立测试目录。脚本会核对精确版本，仅复用其依赖；仍创建全新的临时 profile，不使用该目录下的旧 profile，也不升级运行时。普通用户安装到现有 DSH 应使用 `scripts/install-dsh.ps1`，无需运行这份下载测试宿主的验证脚本。

## 现有 DSH 的安装约束

下列行为已对照官方 rc.1、rc.2 发布包源码及[官方 CLI 参考](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/reference/README.md)、[bundle 安装文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)核验：

| 项目 | 行为和安装要求 |
| --- | --- |
| 选择启动器 | 使用用户指定的精确 `dsh.cmd` 路径。同一电脑可能同时存在独立安装与 npm 全局安装。 |
| profile 目录 | `$DSH_HOME/profiles/<profile>/package.json`；其中 `dsh.profile.bundles` 是 bundle 列表。 |
| 默认根目录 | `DSH_HOME` 未配置或为空时，使用操作系统用户目录下的 `.dsh`。 |
| 插件安装命令 | `<精确启动器> plugin --profile <已有profile> add <tgz绝对路径>`。 |
| 包管理器 | `dsh plugin` 将常规包命令转交 pnpm，pnpm 必须在该进程 PATH 中可用。 |
| 不存在的 profile | `plugin add` 会初始化；用户安装器因此先检查 profile 存在，防止装入误拼的新 profile。 |
| profile 重建 | `--from-default-profile` 会重建 profile，不能用于给用户现有配置追加本插件。 |
| 更新生效 | 新 bundle 要在目标 profile 重启后才生效；配置合成成功不等于运行时注册成功。 |
| SDK peer | 插件运行时共享宿主的 SDK。隔离 `plugin add` 可能提示缺少 `dsh-tools` peer；本次在该提示下两版宿主均实际启动成功。无需为消除提示而给用户 profile 添加另一套 SDK。 |

常规只读检查可使用精确启动器的 `--version`、`plugin --profile <name> list` 和 `--profile <name> --dump-config`。注意先检查本地 profile 已存在；CLI 某些操作可能按需初始化 profile。包卸载遵循 pnpm 命令，例如 `plugin --profile <name> remove dsh-team-hub`，不会删除 Hub 数据。

## 连接参数持久化

插件读取真实进程环境中的 `TEAMHUB_URL` / `TEAMHUB_TOKEN`。官方 DSH 的启动合并优先级从高到低为：

1. 启动进程的环境变量。
2. 启动工作目录中的 `.env`。
3. 选中 `$DSH_HOME/.env`。

Windows 环境变量名按大小写不敏感处理。用户 `.credentials.yaml` 中的键不会自动成为插件可读的 `process.env`，不能只把 `TEAMHUB_TOKEN` 写入该文件。

本项目 Windows 安装器在验证实际 Hub 身份后，备份并更新选定 `$DSH_HOME/.env` 的连接参数，保留其他配置。如果更高优先级已经存在同名变量，应核对来源并保持一致。重启 DSH 后调用 `teamhub_status`，应返回当前成员身份、本机实例 ID 和实际适配器列表；这些结果才是用户环境上的运行核验。

待办看板和增强 Superagent 的适配器仍需依据用户现有插件的公开接口接线，参见 [接入能力与待验证项](integration-gaps.md)。
