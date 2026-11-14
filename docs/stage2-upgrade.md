# DSH 看板接入的升级与回滚

本说明用于已有 Team Hub 和 DSH 工作台的维护窗口。先审查源码及构建产物，确认没有运行中的工单需要保留进程，再安排切换；不要通过清空数据或绕过工作台的洁净检查来安装。

## 组件与准备

- Team Hub 服务端 wheel：`agent_team_hub-0.2.0-py3-none-any.whl`；在新虚拟环境中安装，不覆盖旧环境或旧启动器。依赖约束见 `constraints-tested.txt`，在隔离工作空间先验证安装包及健康接口。候选启动器 `scripts/start-teamhub-stage2.ps1` 不覆盖旧启动器，端口已占用时拒绝启动，正式工作空间必须已经存在。
- DSH 侧 `dsh-team-hub` 0.2.0 和 `dsh-todo-kanban` 0.8.1：前者通过安装包更新，后者是独立工作台维护的插件，应按该工作台的源码审查和发布流程应用。先确认现有 profile 指向正确的插件和本机 overlay。
- 当前机器原有的 profile 安装器把目标版本固定为旧版，不可直接用于本次升级。仓库中的 `scripts/upgrade-dsh-profile-stage2.ps1` 是针对已安装 `0.1.0-workbench.3bd3d820` 的升级器：保留工作台洁净、DSH 停止、预期版本、profile 一致性检查；安装前复制校验配置并保留原依赖目录，失败时恢复。脚本不读取或打印令牌。如果原 `tokenFile` 位于旧插件包的补丁中，更新插件包后还须将该路径保留在本机 overlay 中，并检查组合后的配置。

升级器已在临时 DSH profile 中验证运行中与脏工作区拒绝、安装后版本不匹配时回滚、正常升级、重复运行无改动和 profile 备份，并于 2026-11-14 在本机正式 profile 执行；不覆盖其他旧版或不完整的 profile。本机旧 `tokenFile` 原来位于插件包补丁中，升级后已恢复到本机 overlay 并验证组合配置。独立验证入口是 `scripts/verify_profile_upgrade.py`，参数与环境要求见 `--help`。

升级器的 `-CurrentVersion` 和 `-TargetVersion` 参数可明确指定其他已验证的版本组合；0.2.0 到 0.3.0 的升级步骤见 [通用适配协议升级说明](adapter-upgrade.md)。

## 切换顺序

1. 审查并按工作台规则处理本次看板源码与架构图改动。工作台发布涉及远端推送，应由维护者决定。部署前工作区须干净；准备好新的 wheel、两个插件安装包和新的服务虚拟环境。
2. 用现有版本的 `python -m teamhub backup --data-dir <当前数据目录> --output <新的备份文件.zip>` 生成 SQLite 在线快照及附件备份，并核验备份可恢复。`scripts/verify_existing_snapshot.py <数据目录>` 只在临时副本上验证迁移，不是正式切换时的备份。
3. 在允许的维护窗口内停止对应的 DSH profile 和 Hub 服务，确认目标端口不再有监听进程。备份看板实际数据目录和现有 profile、启动器、环境及本机配置；保留原轮次工单和令牌文件。停止后再生成切换前的最终一致备份，确认时间和内容可恢复。
4. 先在备份恢复副本中启动新服务并验证 schema 迁移、旧数据、身份、静态页面和流水线接口。正式数据目录的第一次新版本启动会将 schema 1 升到 2；不要在未确认备份前启动。保留旧环境与启动器，记录新旧版本对应关系。准备好的 0.2.0 环境可用 `scripts/start-teamhub-stage2.ps1 -TeamHubHome <本机TeamHub目录>` 启动；先检查目标端口已释放。
5. 工作台已干净且 DSH 已停止时，用经核验的安装包运行候选安装器：

   ```powershell
   powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\scripts\upgrade-dsh-profile-stage2.ps1 `
     -MachineFile <本机machine.local.json> -PackageFile <dsh-team-hub-0.2.0.tgz> -TeamHubHome <本机TeamHub目录>
   ```

   脚本会自行备份 profile 清单及原 `node_modules`。如果它拒绝版本、工作区或运行状态，先检查原因，不应修改保护条件强行继续。
6. 按工作台现有应用流程部署 0.8.1 看板源码；再启动新 Hub 和 DSH。若旧安装包将 `tokenFile` 写在包内补丁，升级前应把其路径保留到本机 overlay，再检查组合配置；不要将令牌写入公共仓库。确认 Hub 健康检查和流水线接口可用，`teamhub_status` 显示当前成员及可用看板适配器。选定一条真实业务流程后，显式使用 `teamhub_pipeline_link`；未订阅的流程不会自动建卡。观察自动对账、业务状态和本地字段，再由参与团队完成正式业务验收。

某些 Windows 安装目录只允许所有者访问：如果受限会话报告无法读取 DSH 自带 PTC 运行文件，应先检查实际 ACL，而不是关闭所有沙箱。此次本机只为两个公开运行文件添加读取权限，并为其七级父目录添加不继承的遍历及读取属性权限；没有授予写权限或目录列表权限，原 ACL 存在本机切换备份中。其他机器的安装路径和既有 ACL 可能不同，不应盲目复制这一权限修改。

如需撤销此次 ACL 修改，可使用 `scripts/restore-stage2-dsh-acl.ps1 -Manifest <备份目录>/dsh-runtime-acl-change.json -RuntimeRoot <本机Node安装目录>`。脚本先检查全部目标仍是普通路径，且当前 ACL 与记录的修改后状态一致；若权限后来已被修改则拒绝覆盖。恢复原 ACL 后，该机器的受限会话可能再次无法读取 PTC 运行文件。

## 回滚

DSH 侧安装失败时，候选安装器会尝试恢复安装前的 profile 文件与依赖目录；检查其输出并保留备份。需要手工回滚时先停 DSH，核对备份后恢复原 profile、依赖和工作台版本。Hub 数据一旦升级，不应直接用旧服务打开新 schema：先保留切换后数据，再恢复切换前数据库与附件备份，使用对应的旧环境和旧启动器启动。看板首次关联前还会生成 `board.before-team-hub-v1.json`；恢复它会回到首次关联前的快照，不能合并其后的本地编辑，恢复前应另存当前看板。

回滚期间保留两个时点的数据；涉及切换后新产生的事项、交付或本地编辑时，先与负责人核对，不能把恢复旧备份误认为自动合并。
