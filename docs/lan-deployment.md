# 局域网部署与两机验收

一台机器运行唯一的中央 Hub，数据库留在这台机器本地；另一台机器通过同一个 Web 界面或自己的 DSH、CLI、MCP 连接。推荐让 Hub 继续监听 `127.0.0.1:8765`，另起 TLS 入口监听选定的私网 IP。这样本机 DSH 的原有连接可以保留，停止 TLS 入口即可撤销远端访问。不要把 SQLite 目录放到共享盘由两台机器同时打开。

## 现场准备

1. 两机在允许互访的公司网络；确认公司政策允许开放指定端口。申请带服务器实际 DNS 名或 IP 的证书：证书 SAN 必须包含浏览器访问的名称或 IP，证书链由两台机器信任的 CA 签发。服务器保管 PEM 证书链及私钥；客户端只需要 CA 公钥，不应获得服务器私钥。
2. 在中央机检查网络（每次进入新网络重新查看，不沿用之前的 Wi-Fi 地址）：

   ```powershell
   Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.AddressState -eq 'Preferred' -and $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | Select-Object IPAddress,InterfaceAlias
   Get-NetConnectionProfile | Select-Object InterfaceAlias,NetworkCategory
   ```

   根据正在使用的网卡选一个 RFC 1918 私网 IPv4。本文的 TLS 入口拒绝公网、回环和通配地址；如果公司使用其他网段，请由网络管理员提供合规的 TLS 反向代理。确认两台机器解析到的 DNS 名或地址与证书一致。
3. 按工作台规则检查在途执行并备份 Hub 数据与附件、DSH 看板和本机配置。Hub 在线快照命令是 `python -m teamhub backup --data-dir <数据目录> --output <新的备份.zip>`；备份含凭据摘要及操作回执，应按正式数据保护。先在新目录恢复并检查，不覆盖原数据。
4. 两机都用受信任的浏览器；第二台若需 DSH，先安装兼容版本和 Team Hub 插件。其他 harness 需要 Python 3.11+、项目的 `[mcp]` 依赖和独立成员令牌。浏览器、Node、Python 的信任库可能不同，要分别验证。

## 启动中央 HTTPS 入口

先确认正式 Hub 本机健康且 `127.0.0.1:8765` 已监听。以下使用已安装 Team Hub 0.5.2 的 Python 启动前台入口；替换示例路径和地址，不要把私钥提交到仓库。

```powershell
$hubPython = '<Hub Python 的绝对路径>'
$listenIp = '<现场选择的本机私网 IPv4>'
$certFile = '<证书链 PEM 的绝对路径>'
$keyFile = '<服务器私钥 PEM 的绝对路径>'
& $hubPython -m teamhub.lan_proxy --listen-host $listenIp --port 8766 --backend-port 8765 --certfile $certFile --keyfile $keyFile
```

入口仅转发 TCP/TLS 到 `127.0.0.1:8765`，不改 Hub 的数据、令牌或 DSH 配置。前台窗口保持打开，关闭窗口或按 Ctrl+C 即停止远端入口。本机仍可使用原有 `http://127.0.0.1:8765`；第二台打开 `https://<证书匹配的名称或IP>:8766`。证书出错时修复信任和 SAN，不要跳过浏览器警告。入口不会自动修改防火墙或网络路由，也不会创建公网映射。

已对 0.5.2 入口转发到 0.5.0 后端做过只读身份与页面检查。0.5.0 网页在普通局域网 HTTP 下仍存在随机编号兼容问题；切换到可信 HTTPS 后不依赖该兼容路径。0.5.2 中的 HTTP 兼容修复只有升级后端所提供的网页资源后才生效。

如果主机防火墙阻挡且公司允许，由管理员只为目标设备和 Private 配置文件添加规则，例如把 `<第二台IPv4>` 换为实际地址（需要管理员 PowerShell）：

```powershell
New-NetFirewallRule -DisplayName 'TeamHub LAN 8766' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8766 -LocalAddress $listenIp -RemoteAddress '<第二台IPv4>' -Profile Private
```

不要对 Public 配置文件或所有远端地址放行；若当前网络不是 Private，按公司网络策略处理，不擅自更改网络分类。结束后按规则名核实并移除本次创建的规则。

也可不用上述入口，直接以 `python -m teamhub serve --data-dir <目录> --host <私网IP> --port 8766 --ssl-certfile <证书链PEM> --ssl-keyfile <私钥PEM>` 启动 HTTPS 服务。此方式只监听所选地址，原来的本机 HTTP 和 DSH 地址不会自动继续可用；同一数据目录不能同时启动两个 Hub 进程。

## 管理员、成员和客户端

- 两台机器打开同一个 Hub 页面；「连接设置」输入各自的令牌。管理员登录后，在同一页「团队与成员」创建团队、成员并保存当次显示的令牌，通过可信渠道分别交给本人；普通成员登录后不会看到管理员入口。访问令牌属于个人凭据，不写入文档、代码、聊天记录或命令历史。
- 第二台 DSH 安装 `dsh-team-hub` 后，在其本机 profile/overlay 设置 `serverUrl` 为 HTTPS 地址、`tokenFile` 为该成员的私有令牌文件，并保留唯一的客户端实例与独立本机状态目录。`serverUrl` 优先于 `TEAMHUB_URL`，环境变量中的令牌优先于 `tokenFile`；确认没有遗留值覆盖配置。DSH 启动前为 Node 设置 `NODE_EXTRA_CA_CERTS=<CA PEM 路径>`（如果公司 CA 已在该 Node 实际信任库中可省略），然后重启选定 profile，调用 `teamhub_status`、`teamhub_integration_contract`。看板与执行器仍需各自安装、配置并在状态中可用；不能仅凭 Hub 连通推断已启用。
- MCP 端在本机私有 JSON 文件保存 `{"url":"https://<名称>:8766","token":"<成员令牌>"}`，限制文件 ACL。生成宿主配置时可加 `--connection-file <私有JSON绝对路径> --ca-file <CA PEM绝对路径>`；生成器不会覆盖原配置，也不会输出令牌。`--ca-file` 传给 MCP 的 `TEAMHUB_CA_FILE`，用于显式信任该 CA，TLS 校验仍启用。按 [跨 Harness 接入](cross-harness.md) 合入对应宿主配置并调用 `hub_context` 核对身份。CLI/DSH 使用 Node 的 `NODE_EXTRA_CA_CERTS`，该变量必须在对应 Node 进程启动前设置。

## 两台机器逐项验收

1. 记录中央机所选 IP、DNS、端口、服务版本和证书到期时间，不记录令牌。在第二台运行 `Test-NetConnection <服务器IP> -Port 8766`；随后浏览器访问证书匹配的 HTTPS URL，确认无证书警告、页面可显示。
2. 中央机用管理员令牌登录，第二台用不同团队成员令牌登录；在各自「连接设置」核对姓名、团队和角色，确认普通成员没有管理员功能。两端分别刷新页面验证读取。
3. 管理员创建标记为测试的模板，添加两个不同团队角色和两个顺序步骤，分别指定验收人；保存、校验、发布，再创建并启动测试流水线。使用各成员身份分别接单、开工、提交材料及指定验收人验收，检查下游步骤只在前一步通过后激活；最终两端均显示已完成，活动记录有正确操作者。
4. 如需验证 DSH 看板，先检查第二台 `teamhub_status` 的身份、服务和看板，再显式关联测试流水线；核对卡片、Hub 状态和双向命令，最后检查无重复卡片。Superagent、其他执行器或 harness 只在现场完成实际执行与停止确认后才算通过对应验收。
5. 记录每项结果、设备、时间、版本及故障信息。现场两台真实设备和公司网络的结果应与本机模拟分别记录。

## 临时 HTTP 演示

普通 `http://<私网IP>` 不是安全上下文；本版本使用密码学安全随机数生成操作编号，但**令牌、业务内容以及页面代码均可能被网络上的其他人读取或篡改**。仅在获准的隔离网络、独立演示数据库和演示身份下短暂排障，不使用正式成员凭据或真实数据。用 `python -m teamhub serve --demo --data-dir <独立演示目录> --host <私网IP> --port <未占用端口>` 启动，测试完成即停止。不要关闭浏览器的证书或安全检查。

研发环境可使用 `scripts/verify-lan-ui.mjs` 复验：先构建 Web，设置 `TEAMHUB_LAN_IP` 为本机私网 IP、`TEAMHUB_TEST_PYTHON` 为安装服务依赖的 Python、`TEAMHUB_PLAYWRIGHT_ENTRY` 为已有 Playwright 的入口文件、`TEAMHUB_CHROME` 为已有 Chrome 的绝对路径，再执行 `node scripts/verify-lan-ui.mjs`。脚本使用独立临时演示数据、随机端口和三个浏览器会话，完成后停止测试服务；不会使用正式令牌。它验证单机非回环访问，不能代替两台物理设备的现场验收。

## 排查与回滚

| 现象 | 检查 |
| --- | --- |
| 第二台 TCP 不通 | 现场 IP、端口、服务存活、双方网段、公司网络隔离和仅针对目标 IP 的防火墙规则 |
| HTTPS 证书错误 | URL 名称与 SAN、有效期、完整证书链、目标客户端信任库；不忽略警告 |
| 页面可打开但身份失败 | 使用正确的 Hub 地址和个人令牌；确认没有沿用演示令牌，检查服务端角色 |
| DSH/MCP 连不上但浏览器正常 | 检查实际进程的地址、身份、CA 配置和优先级；Node 的 CA 配置需在启动前设置 |
| 看板没卡片 | 检查本机适配器及显式订阅，确认 Hub 绑定与同步状态，不重复创建 |
| 旧服务或旧数据需要恢复 | 停止入口；保留当前数据与日志，停止目标 Hub 后将切换前备份恢复到新目录，用对应旧环境启动，核对之后再切换，不能覆盖并丢弃切换后数据 |

仅撤销局域网访问时，停止 TLS 入口并移除本次创建的防火墙规则；本机 Hub 和原有数据不受该操作影响。不要把恢复旧快照当作合并之后新增的数据。
