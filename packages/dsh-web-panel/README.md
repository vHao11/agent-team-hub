# DSH 团队协作台页面

这个可选插件在 DSH 左侧加入「团队协作台」，在 DSH 主面板内显示现有的 Agent Team Hub 网页。它与 `dsh-team-hub` 工具插件独立安装，不替换已有插件、看板或执行器。

```powershell
cd packages/dsh-web-panel
New-Item -ItemType Directory -Force dist
npm pack --pack-destination dist
dsh plugin --profile web add ./dist/dsh-team-hub-web-0.1.0.tgz
```

重启对应的 DSH profile，并确保 Hub 服务已启动。首次使用正式工作空间时，在嵌入页面的连接设置中输入个人 Hub 令牌；页面遵循 Hub 自身的身份和权限，不会自动传送 DSH 插件保存的令牌。

若 profile 由 `my-dsh-workbench` 严格模式管理，不要直接执行上面的 `dsh plugin add`：工作台还需要在本机清单中登记新 bundle 和依赖。停止 DSH 后，在项目根目录使用以下安装器；它先运行工作台要求的同步检查，再备份 profile、安装并登记插件，失败时尝试回滚：

```powershell
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-dsh-web-panel.ps1 `
  -MachineFile <工作台目录>\machine.local.json -TeamHubHome <DSH_HOME>\teamhub
```

默认连接 `TEAMHUB_URL`，未设置时使用 `http://127.0.0.1:8765`。若 DSH 服务器连接 Hub 的地址与浏览器访问地址不同，可在插件配置中分别设置 `serverUrl` 和 `webUrl`，或通过环境变量 `TEAMHUB_URL` 和 `TEAMHUB_WEB_URL` 设置。例如，远程访问 DSH 时，`webUrl` 必须是访问者设备能够访问的 Hub 地址；HTTPS 的 DSH 通常也需要 HTTPS 的 Hub。Hub 的反向代理需要允许被 DSH 页面嵌入。

页面地址不能包含用户名、密码、查询参数或片段。插件的状态接口遵循 DSH 的连接鉴权，仅返回地址与服务状态，不返回令牌。Hub 服务不可用时，面板会显示提示与重新连接按钮。

## 验证范围

`npm test` 覆盖地址校验、DSH 请求鉴权、断线状态和槽位注册。在 Windows 的临时 DSH 0.2.2-rc.1 profile 中，已验证演示工作空间和独立正式测试工作空间的页面打开、令牌登录、页面导航、窄屏、离线提示与重试；没有使用正式数据或模型。安装器另在临时 profile 中验证了同步失败不写入、安装失败回滚、保留既有工具插件和重复安装。正式 profile 仍应在安装后单独验证。
