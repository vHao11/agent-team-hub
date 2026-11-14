# 从 0.2.0 升级通用适配协议

0.3.0 沿用 Hub 数据库 schema 2，并兼容 `dsh-todo-kanban` 的旧订阅文件。升级正式环境前仍应在目标机器验证版本、备份和恢复；示例中的路径需要替换成该机器的实际路径。

1. 构建并验证 0.3.0 wheel 和 DSH 插件包，在新的 Python 虚拟环境中安装；保留旧环境。用 `scripts/verify_service_launcher.py --python <候选Python> --expected-version 0.3.0 --require-contract` 验证候选服务，并用 `scripts/verify_existing_snapshot.py <正式数据目录> --installed` 在候选环境上检查备份副本。
2. 确认 DSH 没有运行中或排队工单，先做在线备份，再停止目标 DSH profile 和 Hub，确认端口释放。使用 `scripts/backup_stage2_local.py` 的 `--source-python`、`--candidate-python`、`--bridge-state-dir` 和 `--label adapter-v1` 生成停止后的最终备份；它包含 Hub 数据和附件、看板、Superagent、profile、启动器及本地桥接订阅。备份与 profile 可能包含私有配置，不提交到仓库。
3. 工作台保持干净且 DSH 已停止时，使用 `scripts/upgrade-dsh-profile-stage2.ps1`，指定 `-CurrentVersion 0.2.0 -TargetVersion 0.3.0` 和经核验的新插件包。该脚本保留原 profile 和依赖目录，在安装失败时尝试回滚；其他已安装版本不能强行覆盖。
4. 检查并保留本机 overlay 的 `tokenFile` 和其他设置，将现有 Hub 启动器指向新虚拟环境，再启动 Hub 与 DSH。验证 `/api/v1/integration/contract`、`teamhub_status` 和旧流程关联；对账应保持同一卡片，不重复创建。若启用 Superagent 适配器，只注册执行能力，实际启动仍需明确操作。
5. 回滚时先停止服务并另存升级后的数据，再恢复相应版本的启动器、profile 和依赖；数据库和看板恢复应以备份为准，不能假设会合并升级后的编辑。详细业务边界见 [适配协议](adapter-protocol-v1.md)。
