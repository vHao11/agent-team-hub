# 适配器与流水线升级

## 从 0.4.0 升级到 0.5.0

0.5.0 沿用数据库 schema 2 和已有看板协议。固定版本安装只在显式派发时发生；默认不自动启用执行。升级前在候选环境运行 `scripts/verify_existing_snapshot.py` 检查旧数据副本，并用 `scripts/backup_stage2_local.py` 备份 Hub、看板、Superagent、profile 和桥接状态。确认宿主空闲后停止目标 DSH 和 Hub，保留旧虚拟环境及 profile；使用 `scripts/upgrade-dsh-profile-stage2.ps1` 指定 `-CurrentVersion 0.4.0 -TargetVersion 0.5.0` 和已验证的新插件包，再切换 Hub 启动器至新环境。重启后核对旧关联与业务数据，用明确标记的测试任务验证自动安装与同步。回滚前先保存升级后的数据，再恢复对应启动器、profile 与旧环境；备份不会合并升级期间的编辑。

## 从 0.3.0 升级到 0.4.0

0.4.0 继续使用数据库 schema 2；旧流水线模板省略依赖字段时保持串行行为，旧看板订阅继续沿用原外部键。双向看板操作需要工作台的 `dsh-todo-kanban` 0.8.2 和 `dsh-team-hub` 0.4.0 一起部署，旧看板只能继续使用其已有快照能力。自动派发默认关闭，升级不会替任何流程开启。

1. 构建界面、wheel 和 DSH 插件包；在新的虚拟环境安装 wheel 并保留 0.3.0 环境。使用 `scripts/verify_wheel.py`、`scripts/verify_service_launcher.py --python <候选Python> --expected-version 0.4.0 --require-contract` 和 `scripts/verify_existing_snapshot.py <正式数据目录> --installed` 检查安装包及数据副本。工作台的看板源码、架构图和本机工作台规则须一并审查和验证。
2. 确认工作台干净、远端同步且没有其他进行中的工作；查看 Superagent 运行中和排队中的工单。先做在线备份，再停止目标 DSH profile 和 Hub 并确认端口释放，随后用 `scripts/backup_stage2_local.py` 备份 Hub、看板、Superagent、profile、启动器及桥接状态，校验恢复结果。
3. 按工作台发布和应用流程更新看板。DSH 已停止且工作台干净时，使用 `scripts/upgrade-dsh-profile-stage2.ps1` 指定已验证的包，以及 `-CurrentVersion 0.3.0 -TargetVersion 0.4.0`；保留自动生成的 profile 和依赖备份，检查现有 overlay 的 `tokenFile` 等本机设置。
4. 将 Hub 启动器指向已验证的 0.4.0 虚拟环境，启动 Hub 和 DSH。核对版本、成员、旧关联与卡片数量，并在明确标记的测试流程中验证看板操作和状态对账。按需逐成员、逐流程启用自动执行；真实模型执行及最终验收须单独核对。
5. 回滚前停止服务并保存升级后数据，恢复对应旧环境、启动器和 profile；如需恢复旧数据库或看板，先保留当前数据，备份不会自动合并升级后的编辑。

## 从 0.2.0 升级到 0.3.0

0.3.0 沿用 Hub 数据库 schema 2，并兼容 `dsh-todo-kanban` 的旧订阅文件。升级正式环境前仍应在目标机器验证版本、备份和恢复；示例中的路径需要替换成该机器的实际路径。

1. 构建并验证 0.3.0 wheel 和 DSH 插件包，在新的 Python 虚拟环境中安装；保留旧环境。用 `scripts/verify_service_launcher.py --python <候选Python> --expected-version 0.3.0 --require-contract` 验证候选服务，并用 `scripts/verify_existing_snapshot.py <正式数据目录> --installed` 在候选环境上检查备份副本。
2. 确认 DSH 没有运行中或排队工单，先做在线备份，再停止目标 DSH profile 和 Hub，确认端口释放。使用 `scripts/backup_stage2_local.py` 的 `--source-python`、`--candidate-python`、`--bridge-state-dir` 和 `--label adapter-v1` 生成停止后的最终备份；它包含 Hub 数据和附件、看板、Superagent、profile、启动器及本地桥接订阅。备份与 profile 可能包含私有配置，不提交到仓库。
3. 工作台保持干净且 DSH 已停止时，使用 `scripts/upgrade-dsh-profile-stage2.ps1`，指定 `-CurrentVersion 0.2.0 -TargetVersion 0.3.0` 和经核验的新插件包。该脚本保留原 profile 和依赖目录，在安装失败时尝试回滚；其他已安装版本不能强行覆盖。
4. 检查并保留本机 overlay 的 `tokenFile` 和其他设置，将现有 Hub 启动器指向新虚拟环境，再启动 Hub 与 DSH。验证 `/api/v1/integration/contract`、`teamhub_status` 和旧流程关联；对账应保持同一卡片，不重复创建。若启用 Superagent 适配器，只注册执行能力，实际启动仍需明确操作。
5. 回滚时先停止服务并另存升级后的数据，再恢复相应版本的启动器、profile 和依赖；数据库和看板恢复应以备份为准，不能假设会合并升级后的编辑。详细业务边界见 [适配协议](adapter-protocol-v1.md)。
