# 统计软件托管平台 · 多虚拟机（云桌面）改造方案

> 文档性质：基于**当前仓库代码与配置的实测阅读**产出，不是凭描述空想的架构。
> 阅读范围：`README.md`、`SECURITY_AUDIT.md`、`guacamole/*`、`nginx/*`、`powershell/*`、
> `src/config/{env,dotenv}.ts`、`src/db/{schema,session,client}.ts`、
> `src/integrations/{guac,guac-token,windows-account,transfer,ssh-probe}.ts`、
> `src/routers/{session,auth,admin}.ts`、`src/{audit,server}.ts`、`src/services/{jobs,platform-config}.ts`、
> `src/schemas/index.ts`、`frontend/src/api/session.ts`、`frontend/src/views/dashboard/Dashboard.vue`。
> 生产 `.env` 含真实密钥与主机地址，**不在本文档中引用任何真实 IP/域名/口令**。

---

## 0-bis. v2 复核修订说明（2026-11-02 二读代码后）

上一版（v1）成文时仓库仍处于 Python/TS 双实现阶段，**引用了大量 `app/*.py`**。
`c58d89b chore: 移除 Python 实现，TS 版成为唯一后端` 之后，这些引用已失效。
本次逐文件重读 TypeScript 实现，结论是：**架构方向（第 3、4、5、7、8、9、10 章）全部成立，无需推翻**；
需要修正的是**落地方式**——尤其是「用什么语言写、要不要独立进程、哪些文件要改」。

### v2 相对 v1 的实质调整

| # | v1（基于 Python 双实现） | v2（基于当前 TS 单实现） | 影响面 |
|---|---|---|---|
| **A1** | DMS「首选 Python FastAPI，写在 `app/`」 | **改为 TypeScript/Fastify，写在 `src/desktop/`**。Python 已从仓库删除，再引 Python 等于回退迁移成果 | 第 6 章全文重写 |
| **A2** | DMS 部署为**独立 systemd 服务 + 独立 worker 进程** | **改为不新增进程**：作为 Fastify 插件挂进现有应用 + 进程内 `setInterval` worker。现有部署本就是单进程单 worker，正好天然保证 worker 唯一性；省掉 Nginx 反代与跨进程鉴权 | 6.2、附录 A |
| **A3** | 「VM 分配是分钟级，别阻塞」只是原则性提醒 | **升级为硬约束并给出原因**：`app.withDb` 会独占一个 PoolClient 并显式 `BEGIN`，长任务放进去会长期占用连接+持事务；且 `src/services/jobs.ts` 是**进程内内存队列**（重启即丢、并发上限 2），不能承载 VM 生命周期 | 5.2、6.2 |
| **A4** | 「改 `app/guac.py::_build_rdp_parameters`」 | 精确为 `src/integrations/guac.ts::buildRdpParameters()`（第 69 行），**且其内部读的是 `settings.rdsHost / rdsPort`**，需改为入参 | 0 章、3.4 |
| **A5** | 推荐「每 VM 32 位随机密码（方案 B），与平台密码解耦」 | **该建议不成立，已推翻**。`login.ps1:68` 的 `net use $WDrive $UserWorkspace /persistent:yes` **不带凭据，走 Windows 透传认证**——VM 本地账号密码必须与文件服务器账号密码一致，否则 W: 映射必失败。改为方案 A′「三端同密码 = 平台密码」，`upsertGuacUser` 不用拆 | 3.4、9.2 —— **这是 v2 最重要的纠正** |
| **A5b** | 未提 SMB 透传这条隐含前提 | 「多机部署」时 `\\fileserver` 的 W:/Z: 能连上，**不是因为共享权限，而是因为 VM 与文件服务器同名同密码**。改密链路因此从 3 端（Windows/Guac/平台）扩展为 4 端（+VM），漏一端用户就「进得去桌面、看不到数据」 | 9.2、附录 C |
| **A6** | 「SSH/PS 封装 host 参数化」一句话带过 | 精确定位 + 补充关键语义：`connectSsh()`（transfer.ts:58）与 `runRemotePs()`（windows-account.ts:184）都无 host 参数；**且 `buildWorkspaceScript` 绝不能在 VM 上执行**（否则每台 VM 建一套 workspace 共享，用户数据会分裂） | 3.3、6.3 |
| **A7** | 未利用既有探测能力 | `src/integrations/ssh-probe.ts` 已有 `probeSshConnection({host,port,...})` 返回判别联合，可直接复用做 VM 探活；只需新增一个 `probeTcp()` 做 3389 探测 | 5.2、6.3 |
| **A8** | 前端接口直接给了 `SessionInfo` 扩展 | 补充 TS 侧硬约束：`sessionOutSchema` 是 Fastify 序列化 schema，**新字段不声明就会被静默丢弃**；且出向 schema 不能比实际产出更严（本仓库已因此踩过 3 次全量 500） | 5.3、附录 C |
| **A9** | 未提 `.env` 严格性 | `assertKnownDotenvKeys()` 对 `.env` 未知键**直接抛 ConfigError 阻断启动**——新增 `DESKTOP_*` 配置必须先加进 `settingsSchema`。因此**灰度开关建议放 `platform_config` 表**而非 `.env` | 8.4、附录 C |
| **A10** | 只提 `login.ps1` 硬编码 | 实际有 **4 个脚本**硬编码 `\\127.0.0.1`：`login.ps1`、`enforce-output-location.ps1`、`setup-workspace-drive.ps1`、`setup-sftp-datadrive.ps1` | 3.8、附录 A |
| **A11** | 「补 `session_end` 审计」 | 确认 `sessions.ended_at` 与 `win_session_id` **至今从未被写入过**（全仓库无写入点）——这是纯新增能力，不是改造 | 2.10、9.6 |

### v2.1 增补（2026-11-02 三读后：资源规格模型）

用户问「VM 资源是动态配置还是固定设置」时暴露一个缺口：v2 的规格**只能来自模板，配额表只有上限没有默认值**，分档需求（VIP 8C16G / 学生 2C4G）唯一解法是多建模板——而模板一多，`software_registry_ver`、`login_script_ver`、模板快照的核对成本全部翻倍。本节增补 4 条修订：

| # | v2 现状 | v2.1 修订 | 影响面 |
|---|---|---|---|
| **A12** | 规格 = 模板字段，克隆后原样继承 | **改为「模板基线 + 配额覆盖」**：`desktop_quotas` 新增 `default_vcpu` / `default_memory_mb`（NULL=取模板值），`desk_instances` 新增 `spec_vcpu` / `spec_memory_mb` 记录分配值；`desktop_vms.vcpu/...` 仍是实际值快照，两者 rebuild 后会分离，都保留 | 7.2、7.4、7.6、3.3 |
| **A13** | 未写明 Provider 侧规格怎么落地 | **明确调用顺序**：Proxmox `clone` API **没有** `cores`/`memory` 参数，必须 clone 后 `POST /config` 设置；新克隆 VM 尚未启动，`clone → config → start` 与「创建时指定」完全等价，仅多一次毫秒级 API 调用 | 6.3 |
| **A14** | 隐含「规格可调」 | **明确不可行边界**：运行中热加 CPU/内存对 Windows 桌面不可靠（virtio-balloon 只能回收不能实时增；CPU hotplug 需 guest 配合）；磁盘只能扩不能缩且需 guest 内扩分区。**变更规格 = 走 rebuild**。`desktop_templates.disk_gb` 降级为**磁盘下限** | 6.3、9.7 |
| **A15** | 挂起只写了「释放内存」 | **补唤醒副作用**：Windows 时间漂移、SMB 会话已被服务端断开（W:/Z: 短暂红叉后自动重连）。方案 A′ 三端同密码在这里是**必需前提**——v1 的每 VM 随机密码模型下，唤醒后 SMB 重连直接失败。这是密码模型的第二个论据 | 9.5 |

### 未变的部分

第 3 章架构、第 4 章选型（仍推荐 Proxmox VE）、第 5 章状态机与异常矩阵、
第 7 章 8 张表 DDL、第 8 章灰度与回滚（仍靠「连接参数全量重写」实现秒级回滚）、
第 9 章安全运维、第 10 章路线图 —— **均不受语言栈变化影响，继续有效**。

> 下文正文中，凡引用 `app/*.py` 的位置均已改为 `src/*.ts`；文件头注释里保留的
> `app/xxx.py` 是仓库自带的溯源标注（标明该 TS 模块对应哪个 Python 模块），不是有效路径。

---

## 0. 结论摘要（先看这段）

| 问题 | 结论 |
|---|---|
| 改造可行性 | **可行，且改造面比想象中小**。因为平台已经做到了「一人一 Guacamole 连接 + 一人一 Windows 账号 + 一人一私有目录」，这套模型天然可以平移到「一人一 VM」。 |
| 最小改动点 | `src/integrations/guac.ts :: buildRdpParameters()`（第 69 行）里写死的 `settings.rdsHost / rdsPort`，改成从新表读取的「该用户 VM 的 IP/端口」。**一处数据源替换**，其余 Guacamole 注册逻辑（建连接、全量重写参数、授 READ 权限）全部复用。 |
| 最大改造点 | `/session/connect` 必须**从同步改异步**（VM 克隆/开机是分钟级），前端从「拿到 url 直接 `window.open`」（`Dashboard.vue:125`）改成「提交分配请求 → 轮询状态 → 就绪后打开」。 |
| 最容易漏的点 | ~~`upsertGuacUser()` 一个函数同时写「guacamole 登录密码」和「RDP 连接密码」，多 VM 后两者必须解耦~~ **（v2 已纠正：方案 A′ 三端同密码下不用拆，见 3.4.1）**。真正容易漏的是 **`login.ps1` 的 `net use` 不带凭据、走透传认证**——这决定了 VM 本地账号密码必须与文件服务器一致（3.4.1 的密码模型由此而来）；以及 VM 挂起唤醒后 SMB 会话已断、依赖同密码才能自动重连（9.5 的 A15）。 |
| 最大风险（非技术） | **Windows / RDS CAL / 统计软件授权成本随 VM 数量线性放大**。共享 RDS 时代是 1 份，多 VM 时代是 N 份。这是本项目改造的**头号决策点**，必须先确认。 |
| 默认虚拟化选型 | **Proxmox VE（自建私有云）为默认推荐**；若不愿自建物理机/无运维人力，则选**阿里云 ECS 按量实例**（与现有资产同栈）。理由见第 4 章。 |
| 数据放哪 | **强烈建议「桌面 VM 无状态化 + 数据留在文件服务器」**（即 W:/Z:/pending 仍走 SMB 共享，`login.ps1` 只把 `\\127.0.0.1` 换成文件服务器名）。这样后端 SFTP 推送/回拉、导出审核、审计链路**零改动**，VM 可随时销毁重建。 |
| 是否新增服务 | **是**，新增「云桌面管理服务」（下称 DMS）。但**不新增进程**：作为 `src/desktop/` 模块 + 一个 Fastify 插件挂进现有应用，配一个进程内定时 worker 消费 `desktop_tasks` 表。现有部署本就是单进程单 worker，天然满足「同一任务不被两个 worker 抢」的约束。 |

---

## 1. 缺失信息清单（**已定稿：2026-11-02 用户确认 Q1~Q10 全部按默认假设执行**）

> **确认记录**：用户于 2026-11-02 拍板「全部按照默认值处理」。下表默认假设即为本方案的**执行基线**，文档各章按此定稿。
> ⚠️ 两条保留条款：**Q2/Q3（统计软件与 Windows 授权）的默认假设属于现实世界承诺**——若后续实际盘点发现授权形态是「单机锁定」或 CAL 数量不足，第 4 章选型与成本结论必须重算，届时回到本表修订；**Q6（隧道）在阶段 4 前必须实测连通**，否则 guacd 探不到 3389。

按「不确认就无法定稿」的优先级排序：

| # | 缺失信息 | 为什么关键 | 本文采用的默认假设 |
|---|---|---|---|
| Q1 | **并发用户规模 / 峰值同时在线数** | 直接决定 VM 规格、宿主数量、授权成本 | 默认 **30 并发、注册用户 100~300** |
| Q2 | **统计软件授权形态**（SPSS/SAS/Stata/R 是单机授权、网络授权还是并发授权？） | 若只能单机授权，多 VM 方案在成本/合规上可能不成立 | 默认 **可迁移/网络授权，或已有多机器授权** |
| Q3 | **Windows 许可来源**（是否有 RDS CAL？用 Windows Server 还是 Win10/11 客户端？） | 每 VM 都要合规授权 | 默认 **Windows Server 2022 标准版镜像 + 已购每用户 RDS CAL** |
| Q4 | **目标虚拟化平台**（自建机房？阿里云？华为云？已有 vSphere？） | 决定 Provider 适配层实现 | 默认 **Proxmox VE 8.x 集群** |
| Q5 | **桌面 VM 的持久性策略**（长期绑定 / 空闲回收 / 用完即毁） | 决定 IPAM、模板、回收调度复杂度 | 默认 **首次登录分配并长期绑定；空闲 7 天挂起、30 天销毁并保留用户数据盘快照** |
| Q6 | **网络可达性**：guacd（在阿里云 Linux Docker 内）如何访问 VM 的 3389？ | 跨机房/跨 VPC 必须先打通，否则 guacd 连不上 | 默认 **Proxmox 与现有 Linux 服务器之间走 WireGuard/IPsec 隧道打通内网** |
| Q7 | **是否有 Active Directory** | 多 VM + 文件服务器 ACL 场景下，无域会导致账号/密码同步非常脆弱 | 默认 **无域（工作组）**，用「两端同名同密码」方案，详见 5.4 |
| Q8 | **用户数据的落点偏好**（留在中心文件服务器 vs 跟随 VM 本地盘） | 决定后端 SFTP 是否需要按 VM 动态寻址 | 默认 **留在中心文件服务器**（改动最小、审计不降级） |
| Q9 | **现有 Windows 云主机在改造后的角色** | 是降级为文件服务器，还是整体退役 | 默认 **降级为文件服务器 + 应急共享桌面** |
| Q10 | 运维人力 / 是否接受引入 Redis、消息队列等新组件 | 决定任务队列形态 | 默认 **不引入新中间件**，用 PostgreSQL `FOR UPDATE SKIP LOCKED` 做任务队列 |

> 上述默认值已于 2026-11-02 全部确认生效。Q2/Q3 若日后与实际授权盘点不符，第 4 章的选型结论需要重算；其余项不符只影响实现细节，不影响架构方向。

---

## 2. 《现有项目理解报告》

### 2.1 当前系统架构概览

```
浏览器 ──HTTPS──> Nginx(chunjindevelop68.xyz) ──> node:8000 ──> Fastify(src/)  ──> PostgreSQL[stats_platform]
   │                                                    │
   │                                                    ├──SSH(ssh2)──> Windows 云主机
   │                                                    │      · 建/改本地账号（src/integrations/windows-account.ts）
   │                                                    │      · 建 C:\workspace\{u}、C:\pending\{u} + NTFS ACL + SMB ABE
   │                                                    │      · SFTP 推 Excel（C:/StatsData）、回拉 pending（src/integrations/transfer.ts）
   │                                                    │
   │                                                    └──裸 SQL(pg)──> PostgreSQL[guacamole_db]
   │                                                           · 建同名 guac 用户（SHA256 大写 HEX 盐）
   │                                                           · 建 windows-{username} RDP 连接
   │                                                           · 授 READ（仅本人）
   │                                                           · 登录时换 authToken 缓存到 guac_auth_tokens
   │
   └──HTTPS(WSS)──> Nginx(guac.xxx) ──> guacamole:8080 ──> guacd:4822 ──RDP 3389──> 同一台 Windows 云主机(RDS)
                                        (Docker 1.6.0)      (Docker 1.6.0)
```

**关键事实**：整条链路上，**所有用户最终 RDP 到同一台 Windows 云主机的同一个 IP**（`settings.rds_host`），靠「Windows 本地账号 + 私有目录 ACL」做隔离，而不是靠网络/主机隔离。

### 2.2 用户访问流程（实测链路）

1. `POST /auth/login` → 校验 `users.password_hash` → 签发 JWT（`jwt_expire_hours=8`）。
2. 登录成功后 `src/integrations/guac-token.ts::rememberLoginToken()`：**用本次明文密码**调 Guacamole `POST /api/tokens` 换 `authToken`，存 `guac_auth_tokens`（TTL 默认 3540s，与 compose 的 `API_SESSION_TIMEOUT=60` 配套）。**只存令牌不存密码**。
3. 用户在仪表盘点「连接数据分析PC」→ 前端 `connectSession()` → `POST /session/connect`。
4. 后端 `src/routers/session.ts` 的 `POST /session/connect`：
   - best-effort 调 `provision_user_workspace(username)`（SSH 到 Windows 幂等补建 W:/pending 目录）；
   - `get_user_connection_id(username)` 查 `guacamole_connection WHERE connection_name='windows-{username}'`；查不到则 `ensure_user_connection()` 补建；
   - **未配置 `GUAC_DB_URL` 时直接 503**（安全修复 A4：拒绝回退到共享连接，防会话串号）；
   - 写 `sessions` 行 + `audit_logs(action='session_connect')`；
   - 拼 `guac_url = {GUACAMOLE_URL}{connection_id}`，令牌有效则追加 `?token=...`。
5. 前端 `window.open(res.guac_url,'_blank')` → Guacamole 免密直连 → guacd → RDP → Windows 登录（`guacRdpAutoLogin` 默认 `false`，即用户手输一次平台密码；多 VM 方案 A′ 建议置 `true`）。
6. Windows 登录触发 `C:\stats-scripts\login.ps1`（公共启动项 `run-login.cmd`）：
   - `net use W: \\127.0.0.1\workspace\{username} /persistent:yes`
   - `\\127.0.0.1\pending\{username}` 创建「待导出目录」快捷方式
   - Z: 由公共脚本映射到 `\\127.0.0.1\StatsData`（只读原始数据）
   - 桌面/文档/下载归位本地默认（**注意：不是重定向到 W:**），隐藏 C: 盘（`NoDrives=4`）、固定文件对话框 PlacesBar
   - 按 `software-registry.json` 生成桌面快捷方式（起始目录 W:）
   - 设置用户级环境变量 `RESULTS_DIR`
   - 重启 explorer
7. 用户在桌面软件里分析；产物放 `pending` → `POST /results/request-export` 由后端 **SFTP 回拉** `C:\pending\{username}` → 与 `testData.csv` 做相似度比对 → ≥60% 转人工审核、<60% 免审发布 30 天有效 → `GET /results/mine` → `POST /results/{id}/download`。

### 2.3 Guacamole 配置方式

| 项 | 现状 |
|---|---|
| 版本 | `guacamole/guacamole:1.6.0` + `guacamole/guacd:1.6.0`（README 明确要求 ≥1.5.6，1.6.0 修 FreeRDP 与 Server 2022 兼容问题 GUACAMOLE-1920） |
| 部署 | Docker Compose 两容器（不再自带 postgres）；`nginx-guacamole.conf` 反代 8080，显式处理 `websocket-tunnel` 的 Upgrade/Connection |
| 认证 | **PostgreSQL JDBC**（`guacamole-auth-jdbc`）。注释明确写了：官方 Docker 镜像不支持 `user-mapping.xml` 文件认证 |
| 库位置 | 与业务库**同一 PostgreSQL 实例、独立 database `guacamole_db`**；容器经 `host.docker.internal` 访问宿主机 |
| 账号来源 | **由业务后端写库创建**，不是手工在 Web UI 建。`src/integrations/guac.ts` 用 `new Pool({connectionString: guacDbUrl})` 直连裸 SQL（guacamole 表不在 Drizzle schema 内） |
| 密码算法 | `salt=32B随机`；`hash=SHA256(明文UTF-8 + salt的大写HEX)`。**大写 HEX 是硬约束**（Java 端 `%02X`），写小写会「写入成功但登录恒 Invalid login」 |
| 连接命名 | `windows-{username}`（`GUAC_CONNECTION_PREFIX` 可配） |
| 授权模型 | 只 `INSERT guacamole_connection_permission(permission='READ')`，**只授本人**。用户之间互不可见 |
| 参数写入 | 每次同步**先 DELETE 全部 parameter 再全量 INSERT**（`_ensure_connection`）。这一点极其重要：它让「改主机地址」变成天然幂等的操作 |
| 安全参数 | 强制 `disable-copy/disable-paste/disable-drive/disable-print=true`、`enable-drive/enable-printing=false`（安全修复 A3，不受配置影响） |
| RDP 安全 | `security=nla` 默认，`ignore-cert` 默认关；README 排错章节给的是 `security=tls` + 关 NLA + `ignore-cert=true` 的实测组合（**两处存在配置张力，见 2.10**） |
| 免密直连 | `GUACAMOLE_URL=.../guacamole/#/client/`，后端拼 `{url}{connection_id}?token=...` |
| 录像 | `GUAC_RECORDING_ROOT` 为空则**不录像**（当前生产大概率未开启） |

### 2.4 RDS 接入方式

| 项 | 现状 |
|---|---|
| 形态 | **单台 Windows Server 2022 云主机**（阿里云 ECS，README 与 nginx 注释均指向阿里云环境/Alibaba Cloud Linux 3），装 `RDS-RD-Server` 角色 |
| 部署脚本 | `powershell/setup-rdsh.ps1`：装角色 + `LicensingMode=4(PerUser)` + 建本地用户并加 `Remote Desktop Users` |
| 域 | **无 AD 域，工作组，按 IP 直连**。README 明确禁止 `New-RDSessionDeployment` / Connection Broker |
| 许可 | 未配许可服务器，依赖 **120 天宽限期**；生产需 RDS CAL |
| 账号 | Guacamole 连的是**服务器本地账户**，由 `src/integrations/windows-account.ts` 经 **SSH**（OpenSSH for Windows + 私钥 `~/.ssh/stats_windows`）执行远程 PowerShell 创建/改密；加 `Users(S-1-5-32-545)` 与 `Remote Desktop Users(S-1-5-32-555)`（按 SID，语言无关） |
| 远程执行封装 | PowerShell 脚本 → **UTF-16LE + Base64** → `powershell -NoProfile -Command -` 从 stdin 喂入（绕命令行长度限制与 GBK 代码页问题）。`timeout=25s` |
| 工作区 | `C:\workspace\{u}` 共享为 `workspace`、`C:\pending\{u}` 共享为 `pending`；`icacls /inheritance:r` + 仅本人/SYSTEM/Administrators；SMB `FolderEnumerationMode AccessBased` |
| 数据投递 | `src/integrations/transfer.ts` SFTP：生成 Excel 推 `C:/StatsData`（Z: 只读），筛选数据推 `C:/workspace/{u}/`（W:）；导出时从 `C:/pending/{u}/` 回拉。⚠️ `connectSsh()` **无 host 参数**，写死读 `settings.sftpHost` |
| 连接目标 | `settings.rdsHost` / `rdsPort=3389`，**全局单值**，写进每个用户的连接参数 |

### 2.5 用户与权限模型

三层身份 + 三层隔离：

1. **平台层**：`users(id, username, role=user|admin|superadmin, is_active, password_version)`；JWT + 角色守卫（`src/auth/guards.ts`）；限流（`src/security/rate-limit.ts`，登录 5/60s、注册 3/300s，按 IP）。
2. **Guacamole 层**：`guacamole_entity(name=username)` + 同名 `guacamole_user` + 专属 `guacamole_connection` + 仅本人 READ。密码与平台**始终一致**（注册/改密都同步）。
3. **Windows 层**：同名本地账号 + 私有目录 NTFS ACL + SMB ABE + 登录脚本的盘符/策略管控。

数据权限：`README` 里描述的 `scopes` / `user_scope` 表在**当前 ORM 中已不存在**（`src/db/schema.ts` 里没有；`schema.sql` 已废弃）。现行实际模型是「软件全开放 + 数据按用户目录隔离 + 导出走相似度审核」。

管理员能力：`/admin/users`、`/admin/audit`、`/admin/pending*`、平台连接配置（`platform_config` 表，key/value；**密码永不落库**）。

### 2.6 数据库与配置存储

**业务库 `stats_platform`（Drizzle schema 是唯一真源，`src/db/schema.ts`）**：

| 表 | 说明 |
|---|---|
| `users` | id, username(uniq), ad_sid, display_name, role, is_active, password_hash, password_version, created_at |
| `sessions` | user_id, win_session_id, guac_identifier, status(pending/active/ended), launched_at, ended_at |
| `pending_files` | 导出申请；`content_sha` 防「申请后改写」；唯一索引 `(user_id,file_name,content_sha) where status in ('pending','approved')` |
| `export_results` | 已发布结果，download_count, expires_at |
| `audit_logs` | user_id, action, detail, ip_addr, status(success/failed), created_at |
| `data_applies` | 数据申请（fields/filters JSONB、time range、priority、status 六态） |
| `messages` | 站内消息 |
| `guac_auth_tokens` | user_id PK, auth_token, expires_at |
| `platform_config` | key PK, value, updated_by |

**Guacamole 库 `guacamole_db`**（`guacamole/initdb.sql`，1.6.0 官方 schema）：`guacamole_entity / user / connection / connection_parameter / connection_permission / connection_group* / connection_history / user_history / user_password_history / sharing_profile* / system_permission` 等。

**配置**：`zod` + **自研 dotenv 解析器** `src/config/dotenv.ts`（**必须自研**：npm dotenv 会把未加引号值里的 `#` 当注释截断，`GUACAMOLE_URL=.../guacamole/#/client/` 会被截成 `.../guacamole/`，导致 `/session/connect` 拼出 `/guacamole/3` → Tomcat 404）。隐私配置无默认值，缺失即 fail-fast。

> ⚠️ **新增配置项的硬门槛**：`src/config/env.ts::assertKnownDotenvKeys()` 复刻了 pydantic-settings 的 `extra=forbid`——`.env` 里出现 `settingsSchema` 未声明的键会**直接抛 ConfigError 阻断启动**。所以任何新配置（如 `DESKTOP_MODE`、`PROXMOX_URL`）必须**先加进 `settingsSchema`**，否则老部署原地起不来。详见附录 C。

### 2.7 现有接口与服务

32 个端点（TS 单实现）。与本次改造直接相关的：

| 方法 | 路径 | 改造相关度 |
|---|---|---|
| POST | `/auth/register` | 高：注册**强制**依次同步 Windows 本地账号 → Guacamole，任一步失败整体 502、平台账号不创建；多 VM 下「注册即预建 VM」是策略选择（默认不做，懒创建） |
| POST | `/auth/login` | 中：换 authToken 逻辑不变 |
| POST | `/auth/change-password` | 中：改密需同步 guac 密码 **+ 该用户 VM 的本地账号密码**（四端同步，见 3.4.1 与 9.2） |
| POST | `/session/connect` | **极高：本次改造主战场** |
| POST | `/data/fetch` | 中：生成 Excel 后 SFTP 推送目标（中心文件服务器方案下不变） |
| POST | `/results/request-export` | 中：SFTP 回拉 pending（中心文件服务器方案下不变） |
| GET | `/admin/*` | 中：需新增桌面管理接口 |
| — | `src/services/jobs.ts` | ⚠️ **进程内内存队列**（`Set` + 数组，并发上限 2），进程重启即丢、无持久化。**不能承载 VM 生命周期任务**，只能作「Excel 生成」这类可重跑任务的旁路 |

**文件服务器侧脚本**：`login.ps1`、`enforce-output-location.ps1`、`configure-rds.ps1`（机器级禁剪贴板/磁盘映射）、`software-registry.json`（软件清单，运维手工维护，平台不参与）。

### 2.8 部署与运维方式

- 后端：`npm start`（`node dist/src/index.js`，Fastify），**单进程**；Nginx 做 HTTPS 终结 + 反代；SECURITY_AUDIT 的 ARCH-06 建议补 systemd + 内存上限。
- Guacamole：Docker Compose（`guacd` + `guacamole`），`restart: always`，录像挂 `./recordings`。
- Windows：手工执行 PowerShell 脚本部署；登录脚本放 `C:\stats-scripts\`，普通用户只读。
- 数据库：宿主机 PostgreSQL；迁移用 `drizzle-kit generate` + `db:migrate`（**禁止 `db:push` 改生产**）。
- 质量门禁：`npm run typecheck` / `npm run lint` / `npm test`（PGlite，372 用例全绿）。
- 单语言：**TS 是唯一实现**（原 Python 版已于 2026-11-02 移除，git 历史可回溯）。

### 2.9 当前架构的优点（改造时要保住的）

1. **一人一连接模型已经建立**——`windows-{username}` + 仅授 READ，天然可以承载「连接目标换成各自 VM」，这是本次改造能低成本实现的根本原因。
2. **连接参数全量重写**——改 IP/端口是幂等操作，回滚就是把 `hostname` 改回 `rdsHost`。
3. **免密直连链路完整**——authToken 缓存 + URL 拼接，前端只认 `guac_url`，VM 换了前端也不用改。
4. **数据出口唯一**——只从 `C:\pending\{用户}` 回拉，配合相似度审核，形成闭环；这套逻辑与「用户在哪台机器上操作」解耦。
5. **账户同步是 SSH + 幂等 PowerShell**——同一套封装可以直接复用到「往每台 VM 里建账号」，只是 host 从固定值变成动态 IP。
6. **安全通道默认全关**——`disable-copy/paste/drive/print` 写死在代码里，不受配置影响，迁移到 VM 后依然生效。

### 2.10 当前架构的风险与改造限制

| 类别 | 风险/限制 | 对多 VM 改造的影响 |
|---|---|---|
| **隔离粒度** | 同一台主机、同一内核、同一 IP。一个用户把主机搞崩/吃满 CPU/中勒索软件，全站受影响；本地管理员提权可触达他人目录（SEC-15 已记录 admin 豁免问题） | 正是改造动因，VM 化后天然解决 |
| **单点** | 一台 Windows 云主机 = SPOF；无会话回收/配额/挂起能力 | VM 化后需新建配额与回收机制（现在没有） |
| **许可** | RDS 120 天宽限期、每用户 CAL、统计软件单机授权 | **VM 化后线性放大**，是最大不确定性（Q2/Q3） |
| **同步假设** | `login.ps1` 硬编码 `$FileServer = "\\127.0.0.1"`——**文件服务器与桌面必须在同一台机器上**。同类硬编码共 **4 处**：`login.ps1:45`、`enforce-output-location.ps1`、`setup-workspace-drive.ps1:94`、`setup-sftp-datadrive.ps1:148` | 多 VM 后必须全部改成可配置的中心文件服务器 UNC，这是必改项（漏一个就断一条盘符/策略） |
| **同步阻塞** | `/session/connect` 假设「连接立即就绪」（查一次库就有 connection_id） | VM 克隆是分钟级，接口必须异步化 |
| **无 IP/资产管理** | 没有任何表记录「谁的桌面在哪儿、什么状态」 | 需新建 8 张表（第 7 章） |
| **RDP 安全配置张力** | `src/config/env.ts` 默认 `guacRdpSecurity='nla'` + `guacRdpIgnoreCert=false`，而 README 排错章节要求 `security=tls` + 关 NLA + `ignore-cert=true`。二者若不一致会导致协商失败 | 多 VM 后要在**模板**里统一固化（关 NLA + SecurityLayer=1），并把连接参数与模板对齐，避免每台 VM 手工调 |
| **录像未开** | `guacRecordingRoot` 默认为空 | VM 化后建议开启（审计不降级要求），但需评估存储（每人每小时约 50~200MB） |
| **无 AD** | 账号靠「两端同名同密码」手工同步 | 多 VM 后会放大这个脆弱点（VM + 文件服务器两端），需 DMS 统一编排或引入 Samba AD |
| **审计缺口** | `audit_logs` 记了 `session_connect`，但**没有 `session_end` / 会话时长 / 具体访问了哪台机器**（Guacamole 侧 `guacamole_connection_history` 有，但没有回流到业务库） | 建议增加会话结束回调 + 定时回流 guac history |

---

## 3. 《多虚拟机改造策略》

### 3.1 推荐的新架构

```
                              ┌──────────────── 控制面（新建）────────────────┐
                              │  云桌面管理服务 DMS (FastAPI/Fastify 独立进程)  │
                              │  · 生命周期/绑定/配额/回收/模板/审计            │
                              │  · PostgreSQL SKIP LOCKED 任务队列 + worker    │
                              └───┬──────────────┬───────────────┬────────────┘
                                  │              │               │
                    Provider API  │              │ 裸 SQL        │ SSH(Win)  PowerShell
                     (克隆/开关机) │              │ (注册连接)     │ (建账号/目录/探测)
                                  ▼              ▼               ▼
  ┌──────────────┐        ┌──────────────┐  ┌────────────┐  ┌──────────────────┐
  │ 虚拟化平台    │        │ guacamole_db │  │ 业务库      │  │ 文件服务器(原 RDS 主机) │
  │ Proxmox/ECS  │        │ guacamole_*  │  │ desk_* 新表 │  │ workspace/pending/S.. │
  └──────┬───────┘        └──────┬───────┘  └─────┬──────┘  └─────────┬────────┘
         │ VM 内网 10.20.x.x     │                │                    │ SMB
         ▼                       ▼                ▼                    ▼
  ┌──────────────────────────────────────────────────────────────────────────┐
  │ 用户桌面 VM(1..N)  ←RDP 3389(仅放行 guacd 源 IP)── guacd ── guacamole ── 浏览器 │
  │  · 模板克隆，无状态（用户数据在文件服务器）                                  │
  │  · 内置 OpenSSH + QEMU Guest Agent + 统计软件 + login.ps1                 │
  │  · 本地账号（同名同密码，由 DMS 下发）                                      │
  └──────────────────────────────────────────────────────────────────────────┘
```

不变的部分：**浏览器 → Nginx → Guacamole → guacd → RDP → Windows 桌面 → login.ps1 → W:/Z:/pending → 导出审核**。
变化的部分：RDP 的终点从「一台固定主机」变成「该用户专属 VM 的动态 IP」，以及在这之前插入一个 DMS 负责把 VM 准备好。

### 3.2 是否需要新增「云桌面管理服务」（DMS）

**需要。** 但遵守三条约束：

1. **不新增进程，但也不能进请求事务**。代码放 `src/desktop/`，作为 Fastify 插件注册进现有应用；**分配动作本身不在这里同步完成**，而是写一条 `desktop_tasks` 记录后立刻返回，由进程内定时 worker（`setInterval` + `FOR UPDATE SKIP LOCKED`）异步推进。原因有两条，都是实测出来的：
   - `app.withDb` 会从连接池独占一个 `PoolClient` 并显式 `BEGIN`（`src/db/session.ts:99`），分钟级任务放进去会长期占用连接 + 持事务，池子很快耗尽；
   - `src/services/jobs.ts` 是**进程内内存队列**，重启即丢，无法承载「VM 已克隆但账号没建」这种需要补偿的半成品状态。
   - 反过来，现有部署是**单进程单 worker**（README 明确这一约束），这恰好保证「同一任务不会被两个 worker 抢」，是这个方案能省掉独立部署的前提。
2. **独立库表**（`desktop_*` 前缀），不动现有 9 张业务表的结构；`users` 只做 `ADD COLUMN`（可回滚）。
3. **只通过三个边界接入现有系统**：① 写 `guacamole_db`（复用 `src/integrations/guac.ts` 的 `inTransaction` 封装）；② 调 Provider API（`fetch`，无需 SDK）；③ SSH 到目标 VM 执行 PowerShell（复用 `src/integrations/windows-account.ts` 的 UTF-16LE Base64 编码封装，**host 需参数化**）。

> 如果你更倾向独立进程（比如后续要把 VM 池交给另一个团队运维），把 `src/desktop/` 抽成 `desktop.main.ts` 单独启动即可——模块边界已经按这个方向切好，只是默认不这么做。

### 3.3 虚拟机的创建、克隆、分配、回收

| 阶段 | 策略 | 说明 |
|---|---|---|
| **创建时机** | 默认 **懒创建（首次 connect 时）**；管理员可 `POST /admin/desktops/prewarm` 预建池 | 懒创建省资源；预建池把等待时间从 90s 降到 5s |
| **创建方式** | **从模板链接克隆（linked clone）**，不做全新安装 | Proxmox：从模板 VM 做 full/linked clone，秒级~十秒级；ECS：`RunInstances` + 自定义镜像，约 60~180s |
| **分配** | `desk_instances` 上 `(user_id) WHERE status IN (...)` **部分唯一索引**保证一人一活跃桌面；并发用 `pg_advisory_xact_lock(hash(user_id))` | 防重复点按钮开出两台 VM |
| **初始化** | 克隆后：⓪ 按配额设置 `cores`/`memory`（`spec_*`，见 7.6；clone API 无此参数，需 `PUT config`）① 开机 ② 等 Guest Agent `guest-ping` 成功 ③ 注入计算机名 `DESK-{username}` ④ SSH 建本地账号（**密码 = 平台密码**，见 3.4.1；只跑 `buildAccountScript`，不跑 workspace 脚本）⑤ 加入 Remote Desktop Users ⑥ 写 Guacamole 连接（hostname=VM IP）⑦ RDP 3389 端口探测 | 第 ⑥⑦ 步必须对同一 IP 做「TCP 3389 可连 + 可选 RDP banner 探测」；探测用 `probeTcp()` 与 `probeSshConnection()` |
| **复用** | 已存在 `status='ready'` 的实例 → 若 `power_state='stopped'` 则开机并重新探测 → 直接返回连接 | 不做重新克隆 |
| **回收** | 三档策略，可配：`idle_suspend_days=7`（挂起，内存释放）、`idle_destroy_days=30`（销毁 VM，保留用户数据盘/快照）、`max_lifetime_days=180`（强制重建） | 数据盘在文件服务器，销毁 VM 不丢数据 |
| **回收执行** | DMS 定时任务每 10 分钟扫描 `last_disconnected_at`，写 `desktop_tasks(type='recycle')` 串行执行 | 销毁前先 `shutdown`（优雅）+ 快照（可选）+ 释放 IP + 删除 guac 连接映射 |

### 3.4 Guacamole 连接如何自动注册

**核心原则：复用现有 `src/integrations/guac.ts`，只改数据源。** 但**必须先把「两个密码」拆开**，这是 v1 漏掉、也是最容易埋雷的一点。

#### 3.4.1 先定密码模型（v1 在这里给错过建议，必须纠正）

现状 `upsertGuacUser(username, password)` 在**一个事务里干了两件互不相干的事**：

```ts
// src/integrations/guac.ts:262
await setUserPassword(conn, entityId, password);              // ① 写 guacamole_user.password_hash（Web 登录用）
const connectionId = await ensureConnection(conn, username, password);  // ② 写连接的 password 参数（RDP 自动登录用）
```

共享 RDS 时代两者恰好同值（同一个 Windows 账号），所以没问题。多 VM 后有三处凭据需要考虑：

| 凭据 | 用途 | 谁能改 |
|---|---|---|
| `guacamole_user.password_hash` | 登录 Guacamole Web（换 authToken） | 用户改密 / 管理员重置 |
| VM 内本地账号密码 | RDP 登录 VM | DMS 建账号 |
| 文件服务器本地账号密码 | **SMB 透传访问 W:/Z:** | `syncWindowsUser()`，随平台密码同步 |

> **决定性约束：`login.ps1:68` 是 `net use $WDrive $UserWorkspace /persistent:yes`——没有显式用户名/密码，走 Windows 透传认证（NTLM 用当前登录凭据）。**
>
> 也就是说：**VM 里的本地账号密码，必须与文件服务器上的同名账号密码完全一致**，否则 W: 映射直接失败，用户进了桌面却没有任何数据。
>
> 现状之所以成立，是因为「RDS 主机 = 文件服务器」，`\\127.0.0.1` 走本机 SAM，天然同凭据。多 VM 后这个隐含前提消失了。

##### 推荐：方案 A′「三端同密码 = 平台密码」

| 凭据 | 取值 |
|---|---|
| Guacamole Web 登录 | 平台密码 |
| VM 本地账号 | **平台密码** |
| 文件服务器本地账号 | **平台密码** |
| guac 连接参数 `password` | **平台密码**（自动登录） |

- **优点**：SMB 透传天然工作，`login.ps1` 一行不用改；与现有「注册/改密/重置三端同步」的语义完全一致；密码强度已由 `validatePasswordStrength()` 保证（8-64 位、四类字符至少三类）。
- **代价**：改密时要多同步一端（VM）。一人一 VM，改密是低频操作，可接受。失败处理见 9.2。
- **不放大现有风险**：guac 库明文存密码这件事（SECURITY_AUDIT 的 B13）在共享 RDS 时代就已经存在，方案 A′ 不新增暴露面。

##### 不推荐：方案 B「每 VM 随机密码」（v1 的建议，有多处自相矛盾）

v1 写的是「每 VM 随机强密码，下发到 ① VM ② 文件服务器 ③ guac 连接参数，与平台密码解耦」。它有两个致命问题：

1. **与改密链路打架**：`syncWindowsUser()` 在用户改密时会**把文件服务器账号改成平台密码**，而 DMS 又把它设成随机密码，两者互相覆盖，最终 SMB 与 RDP 必有一端失效。
2. **想避开这个坑就得在 VM 里存平台密码明文**（`net use /user:...` 显式凭据），而平台密码可登 Guacamole + 文件服务器 —— VM 一旦被攻破就横向移动。**在无域环境下不可接受**。

> 只有引入 Active Directory（组托管服务账号 gMSA，或域账号统一认证）后，方案 B 才真正成立。这也反过来解释了 Q7「是否有 AD」为什么重要：**它决定了密码模型能不能解耦。**
>
> 因此本文默认按 **方案 A′** 推进。如果你后续上了 AD，再切方案 B —— 届时才需要把 `upsertGuacUser` 拆成 `setUserPassword` 与新增的 `updateConnectionCredentials`（本文 3.4.2 只预留了 `updateConnectionTarget`，它不动密码），不作为首期必做项。

##### 那 `upsertGuacUser` 要不要拆？

- **方案 A′ 下：不用拆**。`upsertGuacUser(username, password)` 同时写 Web 密码与连接密码，恰好是想要的行为。
- 但**仍建议新增两个函数**（不影响现状调用）：
  - `updateConnectionTarget({ username, host, port })` —— 只改 `hostname`/`port`，**不动密码**。这是 `rds → vm` 与 `vm → rds` 切换时最常用的操作，语义比「连密码一起重写」更干净。
  - `revokeConnectionRead(username)` —— 回收时撤销 READ（现在只有 `grantRead`，没有反向操作）。

#### 3.4.2 改动点（4 处）

```ts
// src/integrations/guac.ts

// ① buildRdpParameters 增加 host/port 入参（现在硬读 settings.rdsHost / rdsPort，第 69-76 行）
export const buildRdpParameters = (
  username: string,
  password: string | null,
  target?: { readonly host: string; readonly port: number },   // 新增；缺省回落 settings（保持 rds 行为）
): Readonly<Record<string, string>> => { ... }

// ② ensureConnection 透传 target（内部 buildRdpParameters 调用处一并改）
//    upsertGuacUser 保持签名不变，新增可选 target 参数即可 —— 现有 3 个调用点（auth×2、admin×1）零改动
const ensureConnection = (conn, username, password, target?) => { ... }

// ③ 新增：只改连接目标，不动密码（回滚与切换都用它）
export const updateConnectionTarget = async (input: {
  readonly username: string;
  readonly host: string;
  readonly port: number;
}): Promise<number> => { ... }   // 返回 connection_id，并幂等 grantRead

// ④ 新增：回收时撤销 READ（现在只有 grantRead，没有反向操作）
export const revokeConnectionRead = async (username: string): Promise<void> => { ... }
```

> 为什么不用「删了重建连接」来做切换：`guacamole_connection_history` 外键是 `ON DELETE SET NULL`，
> 删连接会抹掉历史会话与 VM 的关联，审计链断裂。**只更新、不删除**是硬要求。

#### 3.4.3 切换/回滚时如何改指向

```
begin tx (guacamole_db):
  entity_id      = ensureEntity(username)                      # 不变
  connection_id  = ensureConnection(username, <平台密码>,
                     { host: target.host, port: target.port }) # 参数全量重写（既有行为）
  grantRead(entity_id, connection_id)                          # 幂等
commit tx (业务库):
  upsert guac_connection_map(instance_id, conn_id, entity_id, params_hash, synced_at)
```

- **切到 VM**：`target = { host: vm.primaryIp, port: vm.rdpPort }`
- **回滚到 RDS**：`target = { host: settings.rdsHost, port: settings.rdsPort }` —— 一次调用即完成，无需删连接、无需动用户、无需动权限

要点：
- **连接名仍用 `windows-{username}`**（`guacConnectionPrefix` 默认 `windows-`），不改前缀 → 免密直连 URL、审计 detail、运维习惯全部不变。
- **参数全量重写**的既有行为正好保证「VM 换了 IP，下次同步即生效」，无需额外清理。
- 连接**不删除**只更新（VM 销毁时可选保留连接并置 `max_connections=0`，或删除）。推荐**保留连接 + 删除 READ 授权**，避免 `guacamole_connection_history` 里的历史记录被 `ON DELETE SET NULL` 抹掉（历史审计价值）。
- **不要用 Guacamole REST API 建连接**：需要 admin token、字段语义与 JDBC 不完全一致、且本项目已有成熟的事务化裸 SQL 实现。REST API 只用于换 authToken（现状如此）。
- **不要往 guacamole 表加列**：guac schema 由官方 `initdb.sql` 管，加列会在下次升级时被 DDL 冲突卡住。映射信息全放 `guac_connection_map`。

### 3.5 用户权限如何映射到虚拟机

| 层 | 映射方式 | 是否变化 |
|---|---|---|
| 平台 → Guacamole 连接 | 不变：`windows-{username}` + 仅 READ | 不变 |
| Guacamole 连接 → VM | 新增：`guac_connection_map.instance_id → desk_instances.id → desktop_vms.id` | 新增 |
| 平台账号 → 文件服务器账号 | 复用：`src/integrations/windows-account.ts` 的 `syncWindowsUser()`，目标主机保持文件服务器（同名同密码） | 零改 |
| 平台账号 → VM 本地账号 | 新增：同一套 PS 脚本 + 新的 host 参数（`runRemotePs(script, action, username, target)`），**只跑账号脚本、不跑 workspace 脚本** | 中改 |
| VM → 用户数据 | 不变：SMB `\\fileserver\workspace\{username}` + NTFS ACL + ABE —— **依赖 VM 与文件服务器同名同密码**（透传认证） | 仅 UNC 主机变化 |
| 管理员 | 新增 `/admin/desktops*` 只读/操作接口；`role` 判定复用 `src/auth/guards.ts` 逻辑 | 新增接口 |

**认证方式建议（v1 在这里推荐错了，已纠正）**：

| 方案 | 做法 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| **A′. 三端同密码 + 开启 auto-login（推荐）** | VM 本地账号、文件服务器账号、Guacamole Web 密码**全部 = 平台密码**；`GUAC_RDP_AUTO_LOGIN=true` 写入连接参数 | ① SMB 透传天然工作（`net use` 不带凭据也能通）；② 注册/改密链路只需多同步 VM 一端，语义不变；③ 密码强度由现有策略保证 | `guacamole_connection_parameter` 明文存密码（guacamole-auth-jdbc 已知设计，现状已然） | **推荐** |
| B. 每 VM 随机密码 | DMS 生成随机密码写入 VM 与连接参数，与平台密码解耦 | 明文泄露只能进自己的 VM | **SMB 透传必失败**：除非在 VM 内 `net use /user:...` 显式传平台密码（等于把平台密码明文留在 VM），否则 W:/Z: 全部打不开 | **不可行（无域前提下）** |
| C. 引入 AD/LDAP | Guacamole 走 LDAP，VM 与文件服务器加域，统一域账号 | 最规范，密码模型彻底解耦（组托管服务账号） | 改动最大，需域控 | 中期目标（也是 B 成立的前提） |

选 A′ 时仍需遵守：**guacamole_db 只监听 127.0.0.1**（现状已如此）、磁盘加密、dump 单独保管；并接受「guac 库泄露 = 平台密码泄露」这一现状风险（B13）。

> 表里 A′ 与 B 的差别不在「安全偏好」，而在 `login.ps1` 的 `net use` 不带凭据这个**硬事实**。
> 如果将来上了 AD，切 C 后可再把密码模型解耦成 B —— 那时才需要 3.4.1 里提到的函数拆分。

### 3.6 数据库需要新增哪些表或字段

见第 7 章完整 DDL。摘要：
- **新增 7 张表**：`desktop_templates`、`desktop_vms`、`desk_instances`、`guac_connection_map`、`desktop_quotas`、`desktop_tasks`、`desktop_ip_allocations`（IPAM，可选并入 `desktop_vms`）。
- **`users` 表只加 3 列**（可回滚）：`desktop_mode`、`desktop_quota_id`、`desktop_enabled`。
- **审计日志复用现有 `audit_logs`**（新增 action 枚举：`desktop_assign` / `desktop_start` / `desktop_recycle` / `session_end`），**不新建审计表**，保证现有 `/admin/audit` 与新日志在同一视图。另建 `desktop_tasks` 记录任务执行明细（含幂等键、重试、错误栈）。

### 3.7 现有功能哪些可以保留

| 功能 | 保留程度 |
|---|---|
| Guacamole 一人一连接、仅授 READ | 100% |
| 免密直连（authToken 缓存 + URL 拼 token） | 100% |
| `guacamole-auth-jdbc` 密码哈希算法 | 100% |
| 导出审核 / 相似度比对 / 免审发布 | 100%（数据在文件服务器，回拉路径不变） |
| 数据获取 `/data/fetch` + SFTP 推送 | 100%（目标仍是文件服务器） |
| Windows 账号同步脚本（建号+加组+ACL） | 90%（复用，host 参数化） |
| `login.ps1`（盘符/策略/快捷方式/隐藏 C:） | 85%（`$FileServer` 改为可配置；RDS 机器级策略段在单用户 VM 上仍适用） |
| `software-registry.json` 软件清单机制 | 100% |
| 审计日志、站内消息、管理员审核 | 100% |
| 限流、JWT、角色守卫 | 100% |
| 质量门禁 | `npm run typecheck && npm run lint && npm test`（vitest + PGlite，372 用例全绿）；新代码必须一并过门禁 |

### 3.8 哪些部分必须修改

| 文件 / 模块 | 修改 |
|---|---|
| `src/integrations/guac.ts :: buildRdpParameters()` | `hostname/port` 从 `settings.rdsHost` 改为入参（来自 VM 记录）；`username/password` 仍用平台密码（方案 A′） |
| `src/routers/session.ts :: connect` | 同步→异步；新增 `POST /session/ensure` + `GET /session/status`；保留 `/session/connect` 兼容老前端 |
| `src/config/env.ts` | 新增 `desktopMode`、`desktop*`、`provider*` 配置段；`rdsHost` 语义改为「应急共享桌面主机」 |
| `src/integrations/windows-account.ts` | `connectSsh()`、`runRemotePs()` 支持传入动态 host（现在是全局 `sftpHost`）；账号创建目标区分「文件服务器」与「用户 VM」 |
| `powershell/login.ps1` | `$FileServer` 从硬编码 `\\127.0.0.1` 改为参数/注册表可配置（默认仍 `\\127.0.0.1` 以便本地单机构建模板时可用） |
| `frontend/src/views/dashboard/Dashboard.vue` + `api/session.ts` | 连接按钮改为「提交 → 轮询 → 打开」，展示进度/失败原因 |
| `frontend/src/views/admin/*` | 新增「云桌面管理」页（实例列表、状态、强制回收、模板、配额、任务） |
| Windows 模板 | 内置 OpenSSH Server + QEMU/云初始化 Agent + 关 NLA + SecurityLayer=1 + 防火墙仅放行 guacd 源 IP + `C:\stats-scripts\` 预置 |

### 3.9 哪些部分建议新增

- DMS 服务与其 `desktop_*` 表、任务队列、worker。
- **Provider 抽象层**（`DesktopProvider` 接口 + Proxmox 实现 + 后续 ECS 实现）。
- **IPAM**（内网 IP 池分配/回收，或用 DHCP 保留 + Agent 回读）。
- **健康检查/自愈**：定时对 `ready` 实例做 TCP 3389 探测，连续失败 N 次自动重启/重建。
- **审计回流作业**：定时把 `guacamole_connection_history` 关联合并到业务侧 `sessions`，补上 `session_end` 与时长。
- **会话录像**（建议开启，补审计短板）+ 录像生命周期清理。
- **监控指标**：VM 池水位、创建耗时 P95、创建失败率、探针失败率、guac 活跃会话数。

### 3.10 哪些部分不建议改动

| 对象 | 原因 |
|---|---|
| `guacamole/initdb.sql`（官方 schema） | 不要用自定义列污染官方表；所有扩展信息放业务库 `guac_connection_map` |
| 连接命名规则 `windows-{username}` | 前端、审计、运维、免密 URL 全依赖它 |
| `disable-copy/paste/drive/print` 强制项 | 安全基线，不随架构变 |
| 导出审核与相似度阈值机制 | 与桌面位置无关，改动只会引入风险 |
| `pending_files` 唯一索引 / `content_sha` 复核 | 并发安全基线 |
| 现有 9 张业务表的既有字段 | 只 `ADD COLUMN`，不改不删 |
| `software-registry.json` 的「运维手工维护」定位 | 平台不参与管理是有意设计，VM 化后克隆模板即可批量分发 |
| Guacamole 版本 1.6.0 | 已是解决 Server 2022 兼容的最低版本，别降 |

## 4. 虚拟化平台选型建议

### 4.1 对比矩阵（★ 越多越好）

| 维度 | Proxmox VE | KVM / libvirt | VMware (vSphere) | Hyper-V | 公有云 VM（阿里云 ECS） |
|---|---|---|---|---|---|
| 自动化创建 VM | ★★★★★ REST API + `qm clone` 一步克隆 | ★★★☆☆ 需 virsh/libvirt API + 自己管镜像 | ★★★★★ vSphere API 成熟 | ★★★☆☆ PowerShell DSC / SCVMM（SCVMM 额外收费） | ★★★★★ OpenAPI，最成熟 |
| API 完善度 | ★★★★★ 官方 REST + 完整 token 体系，文档好 | ★★★☆☆ libvirt API 强但偏底层，要自己封装 | ★★★★★ 最完善（pyvmomi / govmomi） | ★★★☆☆ WMI/CIM + PowerShell，跨平台调用别扭 | ★★★★★ |
| 模板克隆能力 | ★★★★★ 模板 + linked clone 秒级，支持 cloud-init | ★★★☆☆ `virt-clone` / 自己拷 qcow2 + sysprep | ★★★★★ 模板/内容库 + 链接克隆 | ★★★☆☆ 差异磁盘 VHDX 可做但工具链弱 | ★★★★☆ 自定义镜像 + 实例创建（分钟级，无真·链接克隆） |
| 网络隔离能力 | ★★★★☆ Linux Bridge / VLAN / VXLAN(SDN) / 防火墙内置 | ★★★★☆ 同左，但全手工 | ★★★★★ NSX / DVswitch（强但贵） | ★★★☆☆ vSwitch + VLAN，无 SDN | ★★★★★ VPC + 安全组 + 弹性网卡 |
| 快照与恢复 | ★★★★★ 在线快照、回滚快；配合 ZFS/NFS 极稳 | ★★★★☆ virsh snapshot 可用，管理分散 | ★★★★★ 最强 | ★★★★☆ 检查点可用，生产慎用 | ★★★★☆ 云盘快照，按量计费 |
| 运维复杂度 | ★★★☆☆ 中（需懂 Linux/存储/网络） | ★★☆☆☆ 偏高（几乎全自建） | ★★★★☆ 低（GUI 成熟，但要专人） | ★★★☆☆ 中（Windows 运维心智） | ★★★★★ 极低（不用管硬件） |
| 开源/许可成本 | ★★★★★ 开源免费（订阅可选，无功能阉割） | ★★★★★ 完全免费 | ★★☆☆☆ 授权昂贵（Broadcom 后更贵） | ★★★☆☆ 含在 Windows Server 授权内 | ★★☆☆☆ 按量付费，长期最贵 |
| 与 Guacamole 集成难度 | ★★★★★ 低：VM 内网 IP 直连 guacd 3389 | ★★★★★ 低（同上） | ★★★★☆ 中：需打通网络 | ★★★★☆ 中 | ★★★☆☆ 中：需 VPC 打通 + 公网 IP/EIP 成本 |
| 硬件/机房要求 | 需 1~3 台物理机 | 同左 | 同左 + 认证硬件 | 同左 | 无 |
| 弹性伸缩 | ★★☆☆☆ 受物理资源上限 | ★★☆☆☆ | ★★☆☆☆ | ★★☆☆☆ | ★★★★★ |

### 4.2 默认推荐：**Proxmox VE**（附切换条件）

**推荐理由**：

1. **模板链接克隆是决定性优势**——Windows 模板 100GB，全量克隆要几分钟+磁盘翻倍；Proxmox linked clone 秒级完成、共享底层镜像，30 个桌面只多占差分盘（实际每人 10~30GB）。这一项直接决定用户体验（点击后等待 5s vs 5min）。
2. **成本结构最适合固定用户规模**——科研/教学场景用户数可预期（几十到一两百），一次性投入 1~2 台双路服务器（**建议 2×AMD EPYC/至强，合计 ≥64 核 / ≥512GB 内存 / ≥8TB NVMe 或 SSD 阵列**），长期成本远低于按量付费的云主机（30 台 4C8G Windows ECS 常年开机约 ¥2~3 万/月，自建硬件 1.5~2 年回本）。
3. **数据主权**——医学队列数据不出本地机房，合规压力最小（本项目数据是敏感医学队列，这一点权重很高）。
4. **快照/回滚强**——每个用户桌面可独立快照，出问题一键回滚，比云盘快照更灵活且无额外费用。
5. **API 对自动化极其友好**——`POST /api2/json/nodes/{node}/qemu/{vmid}/clone` 一次调用完成，token 鉴权，无需 SDK。
6. **与现有资产不冲突**——现有阿里云 Linux 服务器继续跑 Guacamole + PostgreSQL + DMS，只需一条 WireGuard 隧道打通到 Proxmox 内网。

**切换到公有云 ECS 的条件**（满足任意一条即应改选 ECS）：

- 没有机房/不愿意采购和维护物理服务器；
- 用户规模波动大（如培训期 200 人、平时 20 人），需要真正的弹性；
- 项目周期短（<1 年），无法摊薄硬件成本；
- 组织内已有阿里云专线/VPC 且安全组策略成熟。

**不推荐**：裸 KVM/libvirt（运维成本高，除非团队已深度使用）；VMware（Broadcom 收购后授权成本与不确定性高）；Hyper-V（工具链对 Linux 侧自动化不友好，且本项目 DMS/Guacamole 全在 Linux 侧）。

### 4.3 参考规模估算（默认 30 并发，基线 4C/8G/120GB/用户；分档由配额覆盖，见 7.6）

| 项 | 估算 |
|---|---|
| vCPU | 30 × 4 = 120 vCPU（按 2:1 超配需 60 物理核） |
| 内存 | 30 × 8GB = 240GB（Windows 不可超配，建议 ≥384GB 留余量） |
| 磁盘 | 模板 120GB（共享） + 30 × 差分 30GB ≈ 1TB（NVMe） |
| 宿主 | 2 台（N+1 冗余，单台可承载全部 30 台的 70%） |
| 网络 | 桌面网段 `10.20.0.0/16`，每用户一个 VLAN 或统一 VLAN + 主机防火墙（见第 9 章） |
| 到 Guacamole | WireGuard/IPsec 隧道，仅需放行 guacd → 10.20.0.0/16:3389 |

---

## 5. 用户连接流程设计

### 5.1 状态机

```
                 (用户首次 connect)
                        │
                        ▼
      ┌───────────── NEW ─────────────┐
      │                               │ 预建池命中
      ▼                               ▼
 PROVISIONING ──clone──> CONFIGURING ──> BOOTING ──> PROBING ──> READY
      │  (克隆)          (建账号/注入)   (开机)     (3389 探测)
      │
      └──(任一步失败/超时)──> FAILED ──(重试/人工)──> 回到 NEW
                                 │
                                 └──(不可恢复)──> ERROR（需管理员介入）

READY ──用户打开──> CONNECTED ──断开──> IDLE ──7天──> SUSPENDED ──30天──> DESTROYED
                        │                  │
                        └──异常──> FAILED  └──再连接──> BOOTING(唤醒)
```

`desk_instances.status`：`new | provisioning | configuring | booting | probing | ready | connected | idle | suspended | failed | error | destroyed`
`desktop_vms.power_state`：`unknown | stopped | running | suspended`

### 5.2 完整时序（`POST /session/connect`）

| # | 步骤 | 负责方 | 超时 | 失败处理 |
|---|---|---|---|---|
| 1 | 用户登录 `POST /auth/login`，换 authToken 缓存 | 现有后端 | 3s | 不影响登录（现状） |
| 2 | 前端点「连接」→ `POST /session/connect` | 前端 | — | — |
| 3 | JWT 校验 + `users.desktop_enabled` 检查 | 现有后端 | — | 403（权限不足/已停用） |
| 4 | 查 `desk_instances WHERE user_id=? AND status IN (就绪态)` | DMS（毫秒级，在请求内） | 1s | 无 → 走 5' |
| 5 | **有实例**：写 `desktop_tasks(type='start')` 后**立即返回** `{status:'provisioning', task_id}`；worker 异步做：开机 → `waitAgentReady` → `probeTcp(ip,3389)` | DMS worker | 120s | 见 5.4 |
| 5' | **无实例**：检查配额 → 选模板 → 分配 IP → 写 `desktop_tasks(type='create')` → **立即返回** | DMS（毫秒级，在请求内） | — | 见 5.4 |
| 6 | 克隆完成后：开机 → 等 `guest-ping` → SSH 建本地账号（密码=平台密码）+ 加 Remote Desktop Users + 设置静态 IP（或读回 DHCP IP）。**注意：不跑 workspace 脚本**（见 6.3） | DMS worker | 300s | 见 5.4 |
| 7 | 回写 `desktop_vms.primary_ip/port/protocol/guest_username` | DMS worker | — | — |
| 8 | **Guacamole 注册**：`inTransaction` 内 ensure entity → ensure connection（hostname=VM IP, password=平台密码）→ grant READ | DMS worker | 10s | 见 5.4 |
| 9 | 写 `guac_connection_map`（幂等 upsert） | DMS worker | — | — |
| 10 | 首次响应返回 `{status:'provisioning', task_id, progress, poll_interval}`；轮询到就绪时返回 `{status:'ready', guac_url, instance_id}` | DMS | — | — |
| 11 | 前端轮询 `GET /session/status?task_id=...`（建议 2s 间隔，最长 5min） | 前端 | 300s | 超时提示重试/联系管理员 |
| 12 | 就绪后 `window.open(guac_url,'_blank')`（**必须用户点击触发**，否则被浏览器拦截） | 前端 | — | — |
| 13 | Guacamole 免密直连 → guacd → RDP → VM 桌面 → `login.ps1` 挂载 W:/Z:/pending | — | — | — |
| 14 | 写 `audit_logs(action='session_connect', detail='... vm_id=.. ip=..')` + 更新 `desk_instances.last_connected_at` | DMS | — | — |
| 15 | 断开后：Guacamole 侧 `guacamole_connection_history` 落库；DMS 定时回流写 `sessions.ended_at` + `audit_logs(action='session_end')`，更新 `last_disconnected_at` | DMS | 每 10min | — |
| 16 | 回收：`idle_suspend_days=7` → 挂起；`idle_destroy_days=30` → 快照 + 销毁 + 释放 IP + 撤销 guac READ | DMS | 每 10min | — |

> **对用户可见的体验目标**：首次点击 ≤ 90s 看到 Windows 登录/桌面（Proxmox linked clone + 预置模板可达 30~60s）；二次点击 ≤ 15s（VM 已挂起/关机时的唤醒）或 ≤ 3s（VM 仍在运行）。

### 5.3 前端改造（最小侵入）

```ts
// frontend/src/api/session.ts（现在只有 5 行，新增一个函数即可）
export function connectSession() {           // 保持同名，行为变为幂等的「确保桌面就绪」
  return request.post<unknown, SessionInfo>('/session/connect')
}
export function getSessionStatus(taskId: string) {
  return request.get<unknown, SessionInfo>('/session/status', { params: { task_id: taskId } })
}
```

```ts
// frontend/src/types/index.ts —— SessionInfo 扩展（向后兼容：guac_url 仍存在）
export interface SessionInfo {
  id: number
  /** 后端目前返回 sessions.status（'active' 等）；云桌面模式下新增 'provisioning' | 'failed' | 'error' */
  status: 'active' | 'ready' | 'provisioning' | 'failed' | 'error' | string
  guac_url?: string | null
  task_id?: string | null
  progress?: number          // 0~100
  stage?: string             // 'clone' | 'boot' | 'config' | 'probe' | 'register'（前端只做展示，不要穷举）
  message?: string | null    // 面向用户的中文提示
  poll_interval?: number     // 建议轮询间隔（秒）
  launched_at?: string | null
}
```

`frontend/src/views/dashboard/Dashboard.vue` 的 `connect()`（当前第 125-133 行是 `const res = await connectSession(); if (res.guac_url) window.open(...)`）改为：
调接口 → 若 `status === 'ready'` 直接 `window.open`；否则显示进度条并按 `poll_interval` 轮询 `getSessionStatus`，**就绪后提示用户点击「进入桌面」再 open**（浏览器会拦截非用户手势触发的弹窗）。

> ⚠️ **TS 侧两个硬约束（v1 没写，踩过坑）**
>
> 1. **新字段必须在 `src/schemas/index.ts::sessionOutSchema` 里显式声明**。Fastify 用 schema 做响应序列化，未声明的键会被**静默丢弃**——前端会一直拿到 `undefined` 且后端毫无报错。pydantic 不会这样，这是迁移后新增的陷阱。
> 2. **出向 schema 不能比实际产出更严**。`stage` 用 `z.string()` 而不是 `z.enum([...])`，`status` 同理——本仓库已因「出向 schema 收紧」踩过 3 次全量 500（filters 脏数据、time_range 元组、日期列 type/control）。序列化器对不匹配值是**运行时抛 TypeError**，整个端点 500。入向严格校验，出向原样透传。

> ⚠️ **第三个坑：`status` 的旧值兼容**。现在 `toSessionOut()` 填的是 `sessions.status`，即 `'active'`（`SessionStatus = 'pending' | 'active' | 'ended'`），**不是** `'ready'`。
> 所以前端**不能**写 `if (res.status === 'ready')`——那会让灰度期（后端还没上 DMS）的用户永远进不去。判断应为：
> ```ts
> if (res.guac_url && res.status !== 'provisioning') window.open(res.guac_url, '_blank')
> ```
> 这样「先上前端、后上 DMS」才真正安全（8.7 的前提）。

### 5.4 异常处理矩阵

| 异常 | 检测方式 | 处理 | 用户可见提示 | 是否告警 |
|---|---|---|---|---|
| **VM 创建失败**（Provider 返回错误/任务超时） | Provider task 状态 != OK；`desktop_tasks.attempts` 递增 | 指数退避重试 3 次（2s/8s/30s）；仍失败 → `status='error'`，保留任务栈 | 「桌面创建失败，请稍后重试或联系管理员（工单号 xxx）」 | P1 |
| **IP 分配失败**（IP 池耗尽/DHCP 无响应） | IPAM 无可用地址；开机 60s 后 Agent 未上报 IP | 释放半成品 VM，标记 `error`，**优先修 IP 池** | 同上 | P0（运维） |
| **RDP/SSH 不可达** | TCP 3389 连接超时（3 次 × 5s）；SSH 22 探测失败 | ① 检查 VM 防火墙/网卡 → 自动 `reset` 一次；② 仍失败 → 从**上一份已知好快照**恢复；③ 无快照 → 标记 `error` | 「桌面网络未就绪，正在自动修复（约 2 分钟）」→ 失败则人工 | P1 |
| **Guacamole 连接注册失败**（guac_db 不可达/事务回滚） | 异常捕获；业务库事务已提交则回滚 | 整体回滚（`status='failed'`，VM 保留），下次点击重试；连续 3 次 → `error` | 「桌面已就绪但接入网关失败，请重试」 | P0 |
| **用户权限不足**（`is_active=false` / 角色不允许 / 配额为 0） | 前置校验 | 403，不创建任何资源 | 「账号未开通桌面权限，请联系管理员」 | 否 |
| **资源不足**（宿主 CPU/内存/磁盘水位超阈值） | Provider `/nodes/{node}/status` + DMS 水位计算 | 拒绝创建，`status='failed'`，进等待队列（可选排队号） | 「当前桌面资源已满，已排队（第 N 位）」 | P0（扩容信号） |
| **模板不可用**（模板被删/损坏/正在更新） | 克隆前校验 `desktop_templates.status='active'` + Provider 侧存在性 | 自动切到 `is_default=true` 的备用模板；无可用 → 拒绝 | 「桌面模板维护中，请稍后再试」 | P0 |
| **并发创建冲突**（用户狂点/多端同时请求） | `pg_advisory_xact_lock(hashtext('desk:'||user_id))` + 部分唯一索引 | 第二个请求直接返回**同一个 task_id**，复用进行中的任务（幂等） | 无感（进度条继续） | 否 |
| 部分完成（VM 已建但账号未建） | 任务中断后重启扫描 `configuring` 超时实例 | **补偿任务**：按步骤幂等重做（建账号/授权/注册连接均幂等） | 无感 | P2 |
| 用户数据盘不可达（文件服务器 SMB 挂了） | VM 内探测 `\\fileserver\workspace\{u}` | 仍允许进入桌面但顶部横幅告警；记录审计 | 「数据盘暂时不可用，请勿保存重要文件」 | P0 |

**幂等性要求**（所有 DMS 步骤必须满足）：建账号、`icacls`、ensure connection、grant read、写映射表，全部可重复执行且结果一致。这一点现有代码已经做到（README/代码注释反复强调），新代码必须沿用。

---

## 6. 云桌面管理服务（DMS）设计

### 6.1 技术栈

**全部沿用现有 TS 栈，不引入任何新运行时依赖**（这是 v2 相比 v1 最大的调整）。

| 项 | 选择 | 理由 |
|---|---|---|
| 语言/框架 | **TypeScript + Fastify**，代码放 `src/desktop/`，以 `FastifyPluginAsync` 注册进 `src/server.ts` | Python 版已于 `c58d89b` 移除。再引 Python 意味着重建一套 venv/依赖/部署链路，且要吃回「双实现对齐」的维护成本 |
| ORM | **Drizzle**，新表追加进 `src/db/schema.ts`（唯一真源），迁移走 `drizzle-kit generate` | 与现有 9 张表同一套 schema，避免第二套 ORM 心智 |
| Guacamole 库访问 | 复用 `src/integrations/guac.ts` 的 `inTransaction()` + 裸 SQL | guacamole_* 表不在 Drizzle schema 内（现状如此，也不要改） |
| 任务队列 | **PostgreSQL `SELECT ... FOR UPDATE SKIP LOCKED`** + 进程内 `setInterval` drain | 零新组件（Q10 假设）。**不要用 `src/services/jobs.ts`**——那是内存态、重启即丢 |
| Provider 客户端 | **原生 `fetch`** 手写封装（Proxmox REST 只需 token header + JSON）；阿里云如需签名再评估官方 SDK | Node 22 自带 fetch/AbortSignal，零依赖即可覆盖 Proxmox 全部调用 |
| 远程执行 | 复用 `src/integrations/transfer.ts` + `windows-account.ts`（`ssh2`，UTF-16LE Base64 喂 stdin） | 现有封装已解决中文 Windows 编码问题，只需 host 参数化 |
| 端口探测 | 复用 `src/integrations/ssh-probe.ts` 的 `probeSshConnection()` 做 SSH 探活；新增 `probeTcp()`（`node:net`）做 3389 探测 | 两者都返回判别联合 `{ok:true,...} | {ok:false,message}`，探测失败是业务结果而非异常，正好对上异常矩阵 |
| 并发控制 | `setInterval` 单 worker + 数据库层的 `pg_advisory_xact_lock` + Provider 侧信号量（并发克隆 ≤ 4） | 单进程单 worker 部署下无需分布式锁 |
| 部署 | **不新增 systemd 服务**，随主应用一起起停 | 见 6.2 |

### 6.2 部署方式

**默认形态：零新增部署单元。** 主应用启动时顺带起 worker：

```ts
// src/server.ts 里新增（概念示意）
await app.register(desktopRoutes);            // /desktop/* 与 /admin/desktops/*
if (getSettings().desktopEnabled) {
  startDesktopWorker({ intervalMs: 5_000 });  // setInterval + SKIP LOCKED，进程退出时 clearInterval
}
```

systemd 沿用现有主服务（若尚未配置，按 SECURITY_AUDIT 的 ARCH-06 补）：

```ini
# /etc/systemd/system/stats-platform.service
[Unit]
Description=Stats Platform
After=network.target postgresql.service docker.service

[Service]
Type=simple
User=stats
WorkingDirectory=/opt/stats-platform
Environment=NODE_ENV=production
# 必须单实例：worker 依赖「同一时刻只有一个消费进程」的前提
ExecStart=/usr/bin/node dist/src/index.js
Restart=always
RestartSec=3
MemoryMax=2G          # 比现状 1G 略放宽：Excel 生成 + VM 编排共存

[Install]
WantedBy=multi-user.target
```

约束与理由：

- **`ExecStart` 严禁加 `--workers`/cluster/fork 多实例**。worker 用 `SKIP LOCKED` 本身能抗并发，但「同一用户的 ensure 幂等」还依赖 DB 部分唯一索引，多实例会让排障复杂化；且 README 已明确部署层保证单 worker。
- **不需要改 Nginx**（v1 说要加 `/api/desktop/` 反代——同进程后不需要）。只有把 DMS 拆成独立进程时才需要。
- **不需要改 CORS 白名单**（`src/server.ts:81` 的 `PROD_CORS_ORIGINS` 是硬编码的，同源请求不受影响）。
- **长任务不进请求事务**：`/desktop/ensure` 只做「校验 → 查/建实例 → 写任务 → 返回」，全程毫秒级；真正的克隆/开机/建账号/注册连接在 worker 里推进，进度写 `desktop_tasks`。
- **Guacamole 库连接池**：`guac.ts` 的池 `max: 5`，worker 内复用同一池，不要另建。
- **进程重启安全**：worker 启动时先把 `status='running'` 且 `started_at` 超过 10 分钟的任务重置为 `pending`（幂等重做），这就是 `desktop_tasks` 持久化的价值。

### 6.3 Provider 抽象接口

```ts
// src/desktop/provider/types.ts
export interface VmSpec {
  readonly name: string;          // 'DESK-alice'
  readonly vcpu: number;
  readonly memoryMb: number;
  readonly diskGb: number;
  readonly staticIp?: string;     // 推荐：开机即可连，不必等 Guest Agent
  readonly gateway?: string;
}

export interface Capacity {
  readonly cpuUsage: number;      // 0~1
  readonly memUsage: number;
  readonly diskUsage: number;
  readonly freeIpCount: number;
}

export interface DesktopProvider {
  readonly kind: 'proxmox' | 'libvirt' | 'vmware' | 'hyperv' | 'ecs';
  validateTemplate(tpl: DesktopTemplate): Promise<boolean>;
  /** 返回 provider_ref（Proxmox vmid / ECS instanceId） */
  clone(tpl: DesktopTemplate, spec: VmSpec): Promise<string>;
  start(ref: string): Promise<void>;
  stop(ref: string, graceful?: boolean): Promise<void>;
  suspend(ref: string): Promise<void>;
  reset(ref: string): Promise<void>;
  destroy(ref: string): Promise<void>;
  snapshot(ref: string, name: string): Promise<string>;
  restore(ref: string, snap: string): Promise<void>;
  powerState(ref: string): Promise<'unknown' | 'stopped' | 'running' | 'suspended'>;
  /** 轮询 Guest Agent ping 直到成功或超时（要求模板预装 qemu-guest-agent） */
  waitAgentReady(ref: string, timeoutMs: number): Promise<void>;
  guestIp(ref: string): Promise<string | null>;
  hostCapacity(): Promise<Capacity>;
}
```

> 实现放在 `src/desktop/provider/proxmox.ts`。全部用 `fetch` + `AbortSignal.timeout()`；
> 凭据从 `settings` 读（`PROXMOX_URL` / `PROXMOX_TOKEN_ID` / `PROXMOX_TOKEN_SECRET`），
> **不落库、不进日志**。所有调用的请求摘要与耗时写 `desktop_tasks`，便于审计与回放。

**Proxmox 实现要点**（实测可用的调用序列）：

```bash
# 1) 从模板链接克隆（vmid 由 DMS 从 9000+ 段分配）
#    ⚠️ clone API 没有 cores/memory 参数——规格必须在下一步 config 里设置
POST /api2/json/nodes/{node}/qemu/{tpl_vmid}/clone
     newid=9101&name=DESK-alice&full=0&target={node}&storage={storage}
# 2) config：设置规格 + 静态 IP（cloud-init）或注入首次启动脚本
#    cores/memory 取 desk_instances.spec_*（= quota.default_* ?? template.*，见 7.6）
PUT  /api2/json/nodes/{node}/qemu/9101/config
     cores=4&memory=8192
     ipconfig0=ip=10.20.3.11/16,gw=10.20.0.1
     ciuser=Administrator&cipassword=<随机>
# 3) 开机（此时 VM 从未启动过，步骤 1~2 等价于「创建时指定规格」）
POST /api2/json/nodes/{node}/qemu/9101/status/start
# 4) 等 Agent（QEMU Guest Agent 必须预装在模板里）
GET  /api2/json/nodes/{node}/qemu/9101/agent/ping     # 轮询直到成功，超时 180s
# 5) 回读 IP（若用 DHCP）
POST /api2/json/nodes/{node}/qemu/9101/agent/network-get-interfaces
# 6) 探活（DMS 侧）
nc -z -w3 10.20.3.11 3389 ; nc -z -w3 10.20.3.11 22
```

Windows 模板必须预装 **QEMU Guest Agent**（virtio-win ISO 自带）+ **OpenSSH Server** + **Cloudbase-Init**（可选，用于计算机名/静态 IP）。

**规格可变更边界（v2.1，A13/A14）**——分三个时机，实现时不要越界：

| 时机 | 可行性 | 说明 |
|---|---|---|
| 创建时 | **可配** | `clone → config(cores,memory) → start`，见上。成本仅一次毫秒级 API 调用 |
| 运行中热调整 | **不做** | 内存热添加在 Windows 上基本不可用（virtio-balloon 只能让 guest **归还**内存，不能实时增）；CPU hotplug 需 guest 配合且 Windows Server 上表现不稳。统计软件跑到一半改硬件配置，崩溃风险远大于收益 |
| 事后变更 | **走 rebuild** | `POST /admin/desktops/{id}/rebuild` 重新克隆并重放配置/账号，`spec_*` 重算后生效。磁盘不在变更范围（只能扩不能缩，且 guest 内扩分区是常见工单来源） |

### 6.4 核心接口定义

> 全部走 `/api/desktop` 前缀；`X-User` 由主站 JWT 透传或在 DMS 侧复用同一套 JWT 校验（`JWT_SECRET` 共享）。

#### 用户侧

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/desktop/ensure` | **幂等**为当前用户准备桌面。返回 `{status, instance_id, task_id, guac_url?, progress?, stage?, message?}` |
| GET | `/desktop/status?task_id=` | 轮询任务进度 |
| GET | `/desktop/mine` | 我的桌面概况（状态、IP 脱敏、创建时间、上次连接、剩余配额） |
| POST | `/desktop/mine/release` | 主动释放（销毁并保留数据），需二次确认 |
| GET | `/desktop/mine/history` | 我的桌面会话历史 |

#### 管理侧（`role in (admin, superadmin)`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/admin/desktops?status=&user=&template=&page=` | 实例列表（含 IP、VM ref、状态、时长） |
| GET | `/admin/desktops/{id}` | 详情（含任务链、IP、guac 映射） |
| POST | `/admin/desktops/{id}/power` | `{action: 'start'|'stop'|'suspend'|'reset'}` |
| POST | `/admin/desktops/{id}/recycle` | `{mode:'suspend'|'destroy', keep_snapshot:true}` |
| POST | `/admin/desktops/{id}/rebuild` | 从模板重建（保留用户数据盘） |
| POST | `/admin/desktops/prewarm` | `{count: N, template_id}` 预建池 |
| GET | `/admin/desktop-templates` / POST / PUT / DELETE | 模板 CRUD（含 `status` 上下线） |
| POST | `/admin/desktop-templates/{id}/sync` | 把 `software-registry.json` 与脚本同步到模板 |
| GET | `/admin/desktop-tasks?status=&type=` | 任务执行记录 |
| POST | `/admin/desktop-tasks/{id}/retry` | 重试失败任务 |
| GET | `/admin/desktop-quotas` / PUT | 配额管理（按用户/按角色） |
| GET | `/admin/desktop-metrics` | 池水位、创建耗时 P95、失败率、在线数 |

#### 回调/内部

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/internal/session-end` | 由 Guacamole 会话结束钩子/定时回流触发，写 `session_end` 审计 |
| POST | `/internal/reconcile` | 对账：Provider 实际 VM 与库表差异修正（防手工删 VM 导致脏数据） |

**关键请求/响应示例**

```jsonc
// POST /api/desktop/ensure  → 200
{
  "status": "provisioning",          // ready | provisioning | failed | error
  "instance_id": 42,
  "task_id": "b3f1...",
  "progress": 35,
  "stage": "boot",
  "message": "正在启动您的专属桌面…",
  "poll_interval": 2
}
// 就绪时
{
  "status": "ready",
  "instance_id": 42,
  "guac_url": "https://guac.example.com/guacamole/#/client/57?token=...",
  "vm": { "ip_masked": "10.20.3.*", "protocol": "rdp", "port": 3389 }
}
```

错误码约定：`403` 权限/停用；`409` 并发冲突（返回已有 task_id）；`429` 配额/资源不足（返回排队位）；`503` Provider 不可用；`504` 任务超时（仍可继续轮询）。

### 6.5 与 Guacamole 数据库的交互方式

- **只写 4 张表**：`guacamole_entity`、`guacamole_user`（密码）、`guacamole_connection`(+`_parameter`)、`guacamole_connection_permission`。
- **事务边界**：guac 库事务与业务库事务**分开提交**，顺序为「先 guac 后业务」，业务库失败时对 guac 做补偿删除/回滚（或干脆以业务库为准重试 —— guac 操作全部幂等，重试即可）。
- **不改官方 schema**，不要往 guac 表加列；映射信息全在 `guac_connection_map`。
- **读**：`guacamole_connection_history`（回流审计）、`guacamole_user_history`（登录审计）定时读取，只读不写。
- **参数哈希**：`guac_connection_map.params_hash = sha256(sorted(params))`，用于判断是否需要重新同步，避免每次 connect 都全量重写。

### 6.6 与虚拟化平台 API 的交互方式

- 统一走 `DesktopProvider` 接口，DMS 内做 **信号量限流**（并发克隆 ≤ 4、并发开关机 ≤ 8）。
- Provider 凭据放环境变量（`PROXMOX_URL` / `PROXMOX_TOKEN_ID` / `PROXMOX_TOKEN_SECRET`），**不落库**。
- 所有调用写 `desktop_tasks`（含请求/响应摘要、耗时、错误），便于审计与重放。
- 异步任务用 Provider 的 task UPID 轮询（Proxmox 返回 UPID，`GET /nodes/{node}/tasks/{upid}/status`）。

### 6.7 与现有用户系统的集成方式

| 集成点 | 方式 |
|---|---|
| 认证 | 复用现有 JWT（同一 `JWT_SECRET`，`src/auth/guards.ts::authenticate` 的 preHandler 直接复用）；DMS 不独立发令牌。⚠️ 因为同进程，这里**零额外成本**——若拆成独立进程，才需要把 `authenticate` 抽成共享中间件 |
| 用户信息 | **只读 `users` 表**，不复制用户数据（避免双写不一致） |
| 审计 | 写入现有 `audit_logs`（新增 action），管理员 `/admin/audit` 直接可查 |
| 注册/改密联动 | 注册时不建 VM（懒创建），但仍照现状建文件服务器账号；**改密时四端同步**（文件服务器 → VM → Guacamole → 平台），VM 离线则记 `password_version` 落后、下次 booting 前补偿（见 9.2） |
| 账号停用 | `users.is_active=false` → DMS 定时任务挂起/销毁其桌面 + 撤销 guac READ |
| 数据投递 | 不变（文件服务器）；DMS 不参与 `src/integrations/transfer.ts` 逻辑 |

## 7. 数据模型设计

> 约定：PostgreSQL；`timestamp WITHOUT TIME ZONE`（与现有 `src/db/schema.ts` 的 `utcTimestamp` 一致，避免存量数据被时区偏移解释）；
> 主键 `serial`；外键用 `ON DELETE RESTRICT/SET NULL`；所有表放业务库 `stats_platform`，**前缀 `desktop_`/`desk_`**。
> 表结构在 `src/db/schema.ts` 追加（或新建 `src/db/desktop-schema.ts`），迁移走 `drizzle-kit generate`。

### 7.1 `users`（现状扩展，仅 ADD COLUMN，可回滚）

```sql
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS desktop_mode     varchar(16) NOT NULL DEFAULT 'rds',  -- rds|vm  灰度开关
  ADD COLUMN IF NOT EXISTS desktop_quota_id integer,                             -- FK desktop_quotas.id
  ADD COLUMN IF NOT EXISTS desktop_enabled  boolean     NOT NULL DEFAULT true;   -- 是否允许使用云桌面
CREATE INDEX IF NOT EXISTS ix_users_desktop_mode ON users (desktop_mode);
ALTER TABLE users
  ADD CONSTRAINT fk_users_desktop_quota FOREIGN KEY (desktop_quota_id)
  REFERENCES desktop_quotas (id) ON DELETE SET NULL;
```

| 字段 | 用途 |
|---|---|
| `desktop_mode` | **灰度核心**：`rds`=走老共享桌面，`vm`=走专属 VM。可按人切换，无需发版 |
| `desktop_quota_id` | 个性化配额（为空则按角色默认配额） |
| `desktop_enabled` | 封禁/停开桌面能力（补 SEC-09「无账号停用能力」的桌面侧缺口） |

### 7.2 `desktop_templates`（模板表）

```sql
CREATE TABLE desktop_templates (
  id                       serial PRIMARY KEY,
  code                     varchar(64)  NOT NULL UNIQUE,          -- 'win2022-stats-v3'
  name                     varchar(128) NOT NULL,                 -- '统计软件桌面 v3'
  os_type                  varchar(32)  NOT NULL DEFAULT 'windows',
  os_version               varchar(64),                           -- 'Windows Server 2022 Datacenter'
  provider                 varchar(32)  NOT NULL,                 -- proxmox|libvirt|vmware|hyperv|ecs
  provider_ref             varchar(128) NOT NULL,                 -- 'node=pve1,vmid=9001' / 'm-xxx'
  provider_node            varchar(64),                           -- Proxmox 节点名
  vcpu                     integer      NOT NULL,             -- 基线 vCPU（可被配额 default_vcpu 覆盖，见 7.6）
  memory_mb                integer      NOT NULL,             -- 基线内存（可被配额 default_memory_mb 覆盖）
  disk_gb                  integer      NOT NULL,             -- 磁盘**下限**：仅扩不能缩，不在配额层覆盖（A14）
  storage                  varchar(64),                           -- Proxmox 存储名
  network_bridge           varchar(32),                           -- 'vmbr0'
  vlan_id                  integer,                               -- 桌面网段 VLAN
  guest_username           varchar(64),                           -- 模板内置账号（一般为 Administrator）
  software_registry_ver    varchar(64),                           -- 对应 software-registry.json 版本
  login_script_ver         varchar(64),                           -- login.ps1 版本（便于批量核对）
  status                   varchar(16)  NOT NULL DEFAULT 'active',-- active|disabled|building|error
  is_default               boolean      NOT NULL DEFAULT false,   -- 模板不可用时的兜底
  max_instances            integer,                               -- 该模板最多承载实例数
  created_at               timestamp    NOT NULL DEFAULT now(),
  updated_at               timestamp    NOT NULL DEFAULT now()
);
CREATE INDEX ix_desktop_templates_status ON desktop_templates (status);
CREATE UNIQUE INDEX uq_desktop_templates_default
  ON desktop_templates (is_default) WHERE is_default;   -- 最多一个默认模板
```

用途：模板是「VM 的源」，记录规格/Provider 位置/软件与脚本版本，支撑模板不可用时的自动切换与批量核对。

> **规格模型（v2.1，A12）**：模板存**基线规格**，不同档位靠配额覆盖而非多建模板。原因：模板数量 × 软件升级/脚本版本核对/快照管理成本是线性放大的，而 Proxmox 克隆后改 `cores`/`memory` 只是一次毫秒级 API 调用（见 6.3）。**同一软件环境尽量只维护一个模板**，分档交给 `desktop_quotas`。

### 7.3 `desktop_vms`（虚拟机表 —— Provider 侧实体）

```sql
CREATE TABLE desktop_vms (
  id                serial PRIMARY KEY,
  instance_id       integer REFERENCES desk_instances (id) ON DELETE SET NULL,
  template_id       integer NOT NULL REFERENCES desktop_templates (id) ON DELETE RESTRICT,
  provider          varchar(32)  NOT NULL,
  provider_ref      varchar(128) NOT NULL,              -- Proxmox: '9101'；ECS: 'i-xxx'
  provider_node     varchar(64),
  name              varchar(128) NOT NULL,              -- 'DESK-alice'
  primary_ip        varchar(64),                        -- 10.20.3.11（inet 亦可，varchar 便于脱敏显示）
  mac_address       varchar(32),
  rdp_port          integer      NOT NULL DEFAULT 3389,
  ssh_port          integer      NOT NULL DEFAULT 22,
  protocol          varchar(16)  NOT NULL DEFAULT 'rdp',-- rdp|vnc|ssh
  power_state       varchar(16)  NOT NULL DEFAULT 'unknown',
  vcpu              integer, memory_mb integer, disk_gb integer,   -- 快照创建时实际规格
  agent_ready       boolean      NOT NULL DEFAULT false,
  last_probe_at     timestamp,
  probe_fail_count  integer      NOT NULL DEFAULT 0,
  snapshot_ref      varchar(128),                       -- 回收前快照
  created_at        timestamp    NOT NULL DEFAULT now(),
  started_at        timestamp, stopped_at timestamp, destroyed_at timestamp
);
CREATE INDEX ix_desktop_vms_instance   ON desktop_vms (instance_id);
CREATE UNIQUE INDEX uq_desktop_vms_ref ON desktop_vms (provider, provider_ref) WHERE destroyed_at IS NULL;
CREATE INDEX ix_desktop_vms_ip         ON desktop_vms (primary_ip) WHERE destroyed_at IS NULL;
CREATE INDEX ix_desktop_vms_power      ON desktop_vms (power_state);
```

要点：`instance_id` 为 NULL 表示「已与用户解绑（回收中）」；`uq_desktop_vms_ref` 用部分唯一索引避免 Provider 侧 ref 复用冲突；`probe_fail_count` 支撑自愈。

### 7.4 `desk_instances`（桌面实例表 —— 业务视角的用户桌面）

```sql
CREATE TABLE desk_instances (
  id                serial PRIMARY KEY,
  user_id           integer NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  template_id       integer NOT NULL REFERENCES desktop_templates (id) ON DELETE RESTRICT,
  current_vm_id     integer REFERENCES desktop_vms (id) ON DELETE SET NULL,
  quota_id          integer REFERENCES desktop_quotas (id) ON DELETE SET NULL,
  spec_vcpu         integer,                                -- 分配规格（v2.1：quota.default_* ?? template.*，见 7.6）
  spec_memory_mb    integer,                                -- NULL=按模板基线；rebuild 时重算
  status            varchar(16) NOT NULL DEFAULT 'new',
  last_error        text,
  last_error_at     timestamp,
  provision_started_at  timestamp,
  provision_finished_at timestamp,
  last_connected_at    timestamp,
  last_disconnected_at timestamp,
  connect_count     integer NOT NULL DEFAULT 0,
  rebuild_count     integer NOT NULL DEFAULT 0,
  created_at        timestamp NOT NULL DEFAULT now(),
  updated_at        timestamp NOT NULL DEFAULT now()
);
-- 一人仅一个「活跃」桌面（并发冲突的第一道防线）
CREATE UNIQUE INDEX uq_desk_instances_active_user
  ON desk_instances (user_id)
  WHERE status IN ('new','provisioning','configuring','booting','probing','ready','connected','idle','suspended','failed');
CREATE INDEX ix_desk_instances_status   ON desk_instances (status);
CREATE INDEX ix_desk_instances_idle     ON desk_instances (last_disconnected_at) WHERE status IN ('idle','suspended');
CREATE INDEX ix_desk_instances_updated  ON desk_instances (updated_at);
```

### 7.5 `guac_connection_map`（Guacamole 连接映射表）

```sql
CREATE TABLE guac_connection_map (
  id                  serial PRIMARY KEY,
  instance_id         integer NOT NULL REFERENCES desk_instances (id) ON DELETE CASCADE,
  user_id             integer NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  guac_connection_id  integer NOT NULL,                  -- guacamole_connection.connection_id（跨库，不加 FK）
  guac_entity_id      integer NOT NULL,                  -- guacamole_entity.entity_id
  connection_name     varchar(192) NOT NULL,             -- 'windows-alice'
  target_host         varchar(128) NOT NULL,             -- 当前写入的 hostname（= VM IP）
  target_port         integer      NOT NULL DEFAULT 3389,
  params_hash         varchar(64),                       -- 参数指纹，判断是否需重新同步
  read_granted        boolean      NOT NULL DEFAULT false,
  revoked_at          timestamp,                         -- 回收时撤销授权的时间
  synced_at          timestamp,
  created_at          timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_guac_map_instance ON guac_connection_map (instance_id);
CREATE UNIQUE INDEX uq_guac_map_conn     ON guac_connection_map (guac_connection_id);
CREATE INDEX ix_guac_map_user            ON guac_connection_map (user_id);
```

要点：**跨库引用不加外键**（guac 在另一个 database），一致性由 DMS 的 `reconcile` 任务保证。`params_hash` 避免每次 connect 都全量重写参数。

### 7.6 `desktop_quotas`（资源配额表）

```sql
CREATE TABLE desktop_quotas (
  id              serial PRIMARY KEY,
  code            varchar(64) NOT NULL UNIQUE,          -- 'default' | 'vip' | 'student'
  name            varchar(128) NOT NULL,
  default_vcpu    integer,                              -- v2.1：该档默认规格（NULL=取模板基线，A12）
  default_memory_mb integer,                            -- v2.1：同上
  max_vcpu        integer NOT NULL DEFAULT 8,
  max_memory_mb   integer NOT NULL DEFAULT 16384,
  max_disk_gb     integer NOT NULL DEFAULT 200,
  max_instances   integer NOT NULL DEFAULT 1,           -- 每用户可持有桌面数
  max_daily_hours numeric(6,2),                         -- 每日最长使用时长（null=不限）
  max_idle_days   integer NOT NULL DEFAULT 7,           -- 空闲挂起
  max_life_days   integer NOT NULL DEFAULT 180,         -- 强制重建
  max_lifetime_days integer NOT NULL DEFAULT 30,        -- 空闲销毁
  allow_rebuild   boolean NOT NULL DEFAULT true,
  template_id     integer REFERENCES desktop_templates (id) ON DELETE SET NULL,  -- 该配额绑定模板
  created_at      timestamp NOT NULL DEFAULT now(),
  updated_at      timestamp NOT NULL DEFAULT now()
);
```

（注：`max_life_days` 与 `max_lifetime_days` 命名易混，建议实现时改名为 `rebuild_after_days` / `destroy_after_idle_days`。）

**规格决策规则（v2.1，A12）**——配额从「上限表」升级为「档位表」：

```ts
// 创建/rebuild 时计算分配规格（src/desktop/ 内，概念示意）
const vcpu      = quota?.defaultVcpu    ?? template.vcpu;
const memoryMb  = quota?.defaultMemoryMb ?? template.memoryMb;
if (vcpu > (quota?.maxVcpu ?? vcpu) || memoryMb > (quota?.maxMemoryMb ?? memoryMb)) {
  throw new ConfigError('quota default exceeds quota max');   // fail-fast，防配额表配错
}
// 结果写 desk_instances.spec_*（分配值）；desktop_vms.vcpu/... 记实际值（快照）
```

- `disk_gb` **不进这套覆盖逻辑**：磁盘只能扩不能缩、扩完还要进 guest 扩分区，`desktop_templates.disk_gb` 是下限（A14）。
- 运行中的 VM **不做热调整**；要变规格只能 rebuild（保留用户数据，从模板重新克隆，`spec_*` 重算后生效）。原因见 6.3 的边界说明。

### 7.7 审计日志（`audit_logs` 复用 + 桌面侧 action 枚举）

**不新建表**，保证 `/admin/audit` 一处可查。新增 action：

| action | 触发 | detail 建议内容 |
|---|---|---|
| `desktop_assign` | 首次分配 | `instance_id=.. template=.. vm_ref=..` |
| `desktop_start` / `desktop_stop` / `desktop_suspend` / `desktop_reset` | 电源操作 | `instance_id=.. vm_ref=..` |
| `desktop_attach` | 复用已有桌面 | `instance_id=.. vm_ip=..` |
| `desktop_recycle` | 回收 | `instance_id=.. mode=destroy keep_snapshot=true` |
| `desktop_rebuild` | 重建 | `instance_id=.. from_template=..` |
| `desktop_error` | 不可恢复错误 | `instance_id=.. task_id=.. err=<摘要>` |
| `session_connect` | 现有 | 追加 `vm_id=.. ip=..` |
| `session_end` | 新增 | `duration_sec=.. guac_history_id=..` |
| `desktop_quota_deny` | 配额拒绝 | `reason=capacity|quota` |

`status` 字段沿用 `success|failed`。IP 源地址复用 `get_client_ip()`（注意 SEC-04：XFF 不可无条件信任，保持现有策略）。

### 7.8 `desktop_tasks`（任务执行记录表）

```sql
CREATE TABLE desktop_tasks (
  id             bigserial PRIMARY KEY,
  task_key       varchar(128) NOT NULL,          -- 幂等键：'ensure:user:42:2026-11-02'
  type           varchar(32)  NOT NULL,          -- create|start|stop|suspend|reset|destroy|config|register|recycle|rebuild|probe
  instance_id    integer REFERENCES desk_instances (id) ON DELETE SET NULL,
  vm_id          integer REFERENCES desktop_vms (id) ON DELETE SET NULL,
  user_id        integer REFERENCES users (id) ON DELETE SET NULL,
  status         varchar(16)  NOT NULL DEFAULT 'pending', -- pending|running|success|failed|error|cancelled
  stage          varchar(32),                    -- clone|boot|config|probe|register
  progress       integer      NOT NULL DEFAULT 0,
  attempts       integer      NOT NULL DEFAULT 0,
  max_attempts   integer      NOT NULL DEFAULT 3,
  not_before     timestamp    NOT NULL DEFAULT now(),   -- 指数退避
  provider_task  varchar(128),                   -- Proxmox UPID / ECS RequestId
  request_json   jsonb,                          -- 入参摘要（脱敏，禁存密码）
  error_code     varchar(64),
  error_message  text,                           -- 截断到 2000 字符
  started_at     timestamp, finished_at timestamp,
  created_at     timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_desktop_tasks_key ON desktop_tasks (task_key);
CREATE INDEX ix_desktop_tasks_queue ON desktop_tasks (status, not_before) WHERE status = 'pending';
CREATE INDEX ix_desktop_tasks_instance ON desktop_tasks (instance_id, created_at DESC);
```

**队列取任务**（零新中间件）：

```sql
WITH next AS (
  SELECT id FROM desktop_tasks
  WHERE status='pending' AND not_before <= now()
  ORDER BY created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
UPDATE desktop_tasks SET status='running', started_at=now(), attempts=attempts+1
WHERE id IN (SELECT id FROM next)
RETURNING *;
```

### 7.9 `desktop_ip_allocations`（IPAM，可选）

若用 DHCP + Agent 回读，可省；若用静态 IP（**推荐，开机即可连，无需等 Agent**）：

```sql
CREATE TABLE desktop_ip_allocations (
  id          serial PRIMARY KEY,
  subnet      varchar(64) NOT NULL,          -- '10.20.0.0/16'
  ip_address  varchar(64) NOT NULL,
  vlan_id     integer,
  vm_id       integer REFERENCES desktop_vms (id) ON DELETE SET NULL,
  state       varchar(16) NOT NULL DEFAULT 'free',   -- free|allocated|reserved
  allocated_at timestamp, released_at timestamp
);
CREATE UNIQUE INDEX uq_desktop_ip ON desktop_ip_allocations (subnet, ip_address);
CREATE INDEX ix_desktop_ip_state ON desktop_ip_allocations (subnet, state);
```

### 7.10 关系总览

```
users ──1:1(active)── desk_instances ──N:1── desktop_templates
  │                        │
  │                        └──1:1(current)── desktop_vms ──1:1── desktop_ip_allocations
  │                        │                      └──N:1── desktop_templates
  ├──N:1── desktop_quotas  │
  │                        ├──1:1── guac_connection_map ──(跨库)──> guacamole_connection
  ├──1:N── audit_logs      └──1:N── desktop_tasks
  └──1:N── sessions（现有，补 session_end）
```

---

## 8. 迁移方案（RDS → 多 VM，平滑不停机）

### 8.1 保留现有用户账号

- **完全不动 `users` 表数据**，只 `ADD COLUMN`（`desktop_mode` 默认 `'rds'`）。
- Guacamole 侧账号与连接**一律保留**（`guacamole_entity` / `guacamole_user` / `windows-{username}` 连接）。
- Windows 云主机上的本地账号**保留**（作为应急共享桌面与文件服务器账号）。

### 8.2 保留现有权限

- 平台角色（`user/admin/superadmin`）与 JWT 守卫不变。
- Guacamole 授权模型不变（仅本人 READ）。灰度期间用户只有**一个**连接，只是 hostname 指向不同目标（老主机 or 新 VM），权限语义完全一致。
- 文件服务器 ACL（W:/pending NTFS + SMB ABE）不变，用户数据在迁移前后是同一份。

### 8.3 保留现有审计数据

- `audit_logs` 全量保留，只追加新 action，不删改。
- `guacamole_connection_history` 保留（**回收 VM 时不要删连接**，否则 `ON DELETE SET NULL` 会抹掉历史关联）。
- 迁移前做一次全库备份（业务库 + guacamole_db 分别 dump，现状已有这个约定）。

### 8.4 灰度迁移部分用户

**三级开关，粒度从粗到细**：

| 级别 | 开关 | 存放位置 | 用途 |
|---|---|---|---|
| 全局 | `desktopMode: 'rds' \| 'vm' \| 'hybrid'` | `settingsSchema`（新配置项） | `rds`=全量老架构；`vm`=全量新架构；`hybrid`=按人判定 |
| 用户 | `users.desktop_mode` | 业务库列（`ADD COLUMN DEFAULT 'rds'`） | 白名单用户走 VM，其余走 RDS |
| 会话 | 请求参数 `?mode=vm`（仅管理员/测试） | 请求体/查询串 | 临时验证 |

> **推荐把「全局开关」放 `platform_config` 表而不是 `.env`**。原因：`src/config/env.ts::assertKnownDotenvKeys()` 会在启动时校验 `.env` 键名，新增键必须先改 `settingsSchema` 再发版；而表里改一个 `UPDATE` 即时生效、且天然留痕（`updated_by` / `updated_at`）。
> 代价是要把 `src/services/platform-config.ts::PLATFORM_CONFIG_KEYS` 白名单从 5 个键扩到 6 个（该白名单现在是 `as const` 元组，扩展时要同步 `PlatformConfigView` 与 `savePlatformConfig` 的类型）。
> 若选择走 `.env`，则**必须**同时把 `DESKTOP_MODE` 加进 `settingsSchema`，否则老 `.env` 里没有该键不影响、新 `.env` 里写了反而启动失败——行为很反直觉。

推进节奏：**内部账号（1~2 人）→ 志愿者 5% → 20% → 50% → 100%**，每档观察 ≥ 3 个工作日。

灰度判定代码位置：`src/routers/session.ts` 的 `POST /session/connect` 开头（当前第 22-51 行是「取 user → 校验 → 查/补 connection_id」）：

```ts
// 示意：分支放在 userId 取出之后、guacSyncEnabled 校验之前
const mode = resolveDesktopMode(user, request);   // hybrid 时读 user.desktopMode
if (mode === 'rds') {
  // 走现有共享 RDS 分支（当前 session.ts 的全部逻辑，原样保留 —— 这就是回滚路径）
} else {
  // 走 DMS ensure 分支：写任务 + 返回 task_id
}
```

### 8.5 如何验证新桌面可用（每档灰度的准入检查清单）

1. **登录验证**：用测试账号登录 → 点连接 → 90s 内出现 Windows 桌面。
2. **身份正确**：桌面上 `whoami` 显示的是本人账号（不是 Administrator/他人）。
3. **盘符正确**：W: → `\\fileserver\workspace\{username}`，Z: 可读，`待导出目录` 快捷方式存在且指向本人 pending。
4. **隔离验证**：`\\fileserver\workspace\` 下看不到他人目录（ABE 生效）；尝试访问他人目录被拒。
5. **通道禁用**：复制粘贴无效、无本地盘、无打印机（现有基线不变）。
6. **数据链路**：`/data/fetch` 生成 Excel → W: 盘可见 → 用软件打开。
7. **导出链路**：把文件放进 `待导出目录` → `/results/request-export` → 相似度判定 → 审核 → 下载成功。
8. **审计完备**：`/admin/audit` 能看到 `desktop_assign` / `session_connect` / `session_end`。
9. **回收验证**：空闲挂起后重新连接能唤醒且数据仍在。
10. **破坏性验证**：手动关机 VM → 点连接能自动开机；手动删 VM → `reconcile` 能发现并重建。
11. **改密回归（v2 新增，A′ 专属）**：在平台上改一次密码 → 重新连接 VM → `whoami` 正常、**`net use` 后 W: 能读写**、Z: 可读。这一项专门验证「四端同密码」没有漏掉 VM 那一端；漏了的表现是「桌面进得去、W: 盘红叉」。
12. **改密时 VM 离线**：先挂起 VM → 改密 → 再连接 → 应能唤醒且 W: 可访问（验证 9.2 的补偿逻辑生效）。

### 8.6 如何回滚

| 层级 | 回滚动作 | 耗时 | 影响 |
|---|---|---|---|
| 单用户 | `UPDATE users SET desktop_mode='rds' WHERE id=?` + 调一次 `updateConnectionTarget({host: rdsHost, port: rdsPort})`（或让该用户下次 connect 时自动重写） | 秒级 | 该用户下次连接回到共享 RDS，数据不受影响 |
| 批量 | `UPDATE users SET desktop_mode='rds' WHERE id IN (...)` + 批量为这些用户重写一次 target | 秒级 | 同上 |
| 全局 | `desktopMode` 改回 `rds`（`platform_config` 表里 UPDATE 即时生效；若放 `.env` 则需重启） | 秒级 / 分钟 | 全体回共享 RDS |
| 关闭 worker | `desktopEnabled=false`，worker 停止领取新任务（已在跑的 VM 不受影响） | 即时 | 不再创建/回收，桌面仍可连 |
| 完全下线 | 回退代码（`git revert`）+ `npm run build` + 重启主服务；DB 侧只删 `desktop_*` 表与 `users` 三列 | 分钟级 | 回到改造前 100% 状态 |

> 因为 DMS **与主应用同进程**，不存在「单独停一个服务」的动作 —— 这也意味着**回退 DMS 代码等于回退整个后端**。
> 好处是部署简单；代价是「只想关掉云桌面、保留其他修复」时要用 `desktopEnabled` 开关而不是停进程。
> 如果这个耦合将来成为问题（比如 DMS 迭代频繁、想独立发版），把 `src/desktop/` 抽成独立入口即可（模块边界已按此切好）。

**回滚之所以能秒级完成，靠的是 `ensureConnection()` 的「参数全量重写」**：把 `hostname` 写回 `rdsHost` 即可，不需要删连接、不需要动用户、不需要动权限。

### 8.7 如何避免一次性停机

- 老 RDS 主机全程在线（它就是文件服务器 + 应急桌面），新 VM 并行接入，**不存在切换窗口**。
- 数据库只做 `ADD COLUMN`（PostgreSQL 11+ 带默认值加列是元数据操作，秒级，不锁表重写）。
- 前端改造**向后兼容**：`/session/connect` 在 `rds` 模式下仍同步返回 `guac_url`，前端轮询逻辑只在收到 `status='provisioning'` 时启用。可先上前端、后上 DMS。
- 新表全部 `CREATE TABLE IF NOT EXISTS` 风格，可提前建好，不影响现有请求。

### 8.8 如何处理旧 RDS 连接

1. **保留**：`windows-{username}` 连接继续存在，灰度期间 hostname 在 `rdsHost` 与 VM IP 之间切换。
2. **全量切换后**：`rdsHost` 语义变为「应急共享桌面」，创建一个 `SHARED-EMERGENCY` 连接（**只对 admin 可见**），供文件服务器维护/VM 池故障期间临时使用。
3. **不要删除**老 RDS 上的本地账号与 W:/pending 目录——它们就是文件服务器的 ACL 主体。
4. **最后退役**：确认 100% 用户稳定运行 ≥ 30 天后，才考虑卸载 RDS 角色（`Remove-WindowsFeature RDS-RD-Server`），保留文件服务器角色与 SMB 共享。

---

## 9. 安全与运维方案

### 9.1 虚拟机网络隔离

| 措施 | 做法 |
|---|---|
| 网段 | 桌面 VM 放独立网段 `10.20.0.0/16`（或按用户/部门分 VLAN），与业务网、管理网分离 |
| 入站最小化 | 每台 VM 的 Windows 防火墙入站规则：**仅允许来自 guacd 源 IP 的 3389**，以及来自 DMS 源的 22（SSH）与 5985（可选 WinRM）。其余全部拒绝 |
| 出站管控 | 默认允许访问文件服务器 SMB(445)；**禁止访问其他 VM 的 3389/445**（网段内互隔离）；是否允许公网出网按数据合规要求决定（医学数据建议禁止） |
| VM 间隔离 | Proxmox 侧开启网桥隔离或用 SDN Zone + 每用户 VNet；简单场景可用「同网段 + 主机防火墙」 |
| 与 Guacamole 之间 | WireGuard/IPsec 隧道，**只放通 guacd → 10.20.0.0/16:3389** |
| 无公网 IP | VM 一律不分配公网 IP/EIP，RDP 绝不暴露公网 |

### 9.2 RDP / SSH 账号管理

- **每 VM 本地账号**（`{username}`），由 DMS 创建，加入 `Remote Desktop Users`（SID `S-1-5-32-555`）与 `Users`（`S-1-5-32-545`），**不加入 Administrators**。
- **密码策略：方案 A′ —— 三端同密码 = 平台密码**（理由见 3.4.1：`login.ps1` 走 SMB 透传认证，VM 与文件服务器必须同密码）。因此：
  - 改密链路由现状的「Windows → Guacamole → 平台」扩展为「**文件服务器 → VM → Guacamole → 平台**」，仍是「任一步失败则整体失败、平台密码不变」的语义（对齐 `src/routers/auth.ts::syncExternal` 的 502 处理）。
  - **改密时 VM 离线怎么办**：不要因此让改密失败（用户体验差且与 VM 可用性耦合）。做法是把 `desktop_vms.password_version` 记为落后，**在下一次 ensure 的 `booting` 阶段先同步密码再放行连接**（此时 VM 必然在线）。这条补偿必须在文档门禁里明确，否则会出现「桌面能进、W: 盘打不开」的诡异故障。
  - 避免在 VM 上留下旧凭据：`login.ps1:67` 每次先 `net use W: /delete /y` 再重建，只要改密后让用户注销重登即可清掉旧持久映射；如需强制，DMS 可在改密后 `cmdkey /delete` 清理。
- **Administrator 账号**：模板内禁用或改随机密码并封存（这个随机密码**不参与 SMB 透传**，因此可以且应该与平台密码无关）；DMS 用独立的管理通道（SSH + 专用密钥）维护，密钥只放服务端。
- SSH：仅密钥认证，禁用密码认证；`~/.ssh/authorized_keys` 只放 DMS 公钥；**必须开启主机密钥校验**（SEC-08 指出当前无校验，新链路要修正）。
- 密码永不过期开关沿用 `windowsPasswordNeverExpires`（默认 `false`，即遵循 Windows 42 天策略）；**VM 场景下建议置 `true`**，避免 VM 长期离线后因密码过期导致 42 天后集体登录失败。注意这是**行为变更**，需在模板与 `.env` 一并固化。

### 9.3 Guacamole 权限控制

- 保持「一人一连接 + 仅授本人 READ」；**不授予 UPDATE/DELETE/ADMINISTER**。
- 不给任何普通用户 `CREATE_CONNECTION` 等系统权限（现状如此）。
- `guacadmin` 超级管理员：改强密码、**考虑禁用或改名为非默认名**（`initdb.sql` 默认 `guacadmin/guacadmin`，README 也提示首登改密）。
- `guacamole_db` 只监听 127.0.0.1（现状），并单独备份、单独授权。
- 开启会话录像（`GUAC_RECORDING_ROOT`）后，录像目录按用户隔离、权限 0700，并设置保留期（建议 180 天）。

### 9.4 防止用户访问他人虚拟机

四道防线（缺一不可）：

1. **Guacamole 层**：连接权限只有本人 READ，看不到、点不到别人的连接（现状已实现）。
2. **账号层**：每台 VM **只有本人账号**（Administrator 改随机密码封存），且**不存在跨 VM 通用的"公共账号"**——即便密码同为各自平台密码，A 也不知道 B 的平台密码，猜到 IP 也没有凭据。
3. **网络层**：VM 之间互不可达 3389；用户无法从 VM 内发起对其他 VM 的 RDP。
4. **数据层**：文件服务器 SMB ABE + NTFS ACL（现状），`\\fileserver\workspace\` 下只能看到自己的目录。
5. **附加**：VM 内不暴露内网网段扫描能力（禁 `ping` 出网可选）；审计里记录每个用户实际连的 `vm_id` + IP，便于事后追溯。

> ⚠️ **方案 A′ 下的残留风险，必须知情**：因为「密码 = 平台密码」，一旦某台 VM 内的凭据被提取（内存转储/凭据管理器），攻击者拿到的是**平台密码**——可登 Guacamole Web 与文件服务器。缓解手段：
> ① VM 内普通用户不在 Administrators 组（无法 dump LSASS）；
> ② 只开 RDP 透传、不开 NLA 时注意 `SecurityLayer=1` 的取舍（见模板）；
> ③ 平台侧开启登录限流与异地告警（现有 `rate-limit.ts` + 审计已具备基础）；
> ④ 长期解法是上 AD 走 gMSA。这个残留风险是「无域 + SMB 透传」的必然代价，不是方案缺陷。

### 9.5 快照与数据回收

| 对象 | 策略 |
|---|---|
| 用户数据 | **在文件服务器，不在 VM**。VM 销毁不影响数据。文件服务器侧按现有备份策略（每日增量 + 每周全量） |
| VM 快照 | 销毁前自动打一份快照，保留 30 天后自动清理；重建时可选择回滚到该快照 |
| 模板快照 | 每次模板更新前打快照，命名含日期与 `software-registry` 版本；保留最近 5 份 |
| 回收流程 | `idle 7d` → 挂起（释放内存，保留磁盘）→ `idle 30d` → 快照 + 优雅关机 + 销毁 + 释放 IP + 撤销 guac READ + 写 `desktop_recycle` 审计 |
| 挂起/唤醒副作用（v2.1，A15） | 唤醒后：**① Windows 时间漂移**（挂起期间时钟停走，需 NTP/Agent 同步纠正）；**② SMB 会话已被文件服务器侧断开**，W:/Z: 会短暂显示红叉再自动重连——前提是密码走透传认证（方案 A′，3.4.1）。若按 v1 的「每 VM 随机密码」模型，唤醒后 SMB 重连直接失败（用户进得桌面但盘符全红）。这是方案 A′ 的第二个论据。**建议**：唤醒后由 DMS 先跑一次 `net use` 探测再置 `ready`，把红叉时间挡在探测期内 |
| 数据销毁合规 | 用户销号时：销毁 VM + 快照；文件服务器目录按组织留存策略处理（建议保留 N 天后安全擦除），并写审计 |

### 9.6 审计日志

- 复用 `audit_logs` + 新增 action（7.7），保证 `/admin/audit` 一处可查。
- 新增**会话结束回流**：定时（每 10 分钟）从 `guacamole_connection_history` 读取 `end_date` 非空的记录，写 `sessions.ended_at` 与 `audit_logs(action='session_end', detail='duration_sec=..')`。
  - ⚠️ 复核确认：`sessions.ended_at` 与 `sessions.win_session_id` **目前在全仓库没有任何写入点**（`schema.ts` 定义了列，`session.ts` 只 `insert` 不 `update`）。所以这是**纯新增能力**，不是修复既有逻辑——不要按"链路已存在、只是没接上"去理解。
  - 落地方式：给 `sessions` 加一列 `guac_history_id`（或按 `user_id + launched_at` 近似匹配），否则回流时无法精确对应到哪一次 connect。**这一列很容易在建模时漏掉**。
- 建议补：桌面实例维度可导出「谁在什么时候用了哪台 VM、多久」的报表（合规检查常用）。
- 日志保留：在线 1 年 + 归档 3 年；`audit_logs` 按月分区（量大时）。

### 9.7 资源配额

- 默认配额见 `desktop_quotas`（7.6）：`max_instances=1`、`max_idle_days=7`、`destroy_after_idle_days=30`、`rebuild_after_days=180`。
- **规格分档（v2.1）**：`default_vcpu` / `default_memory_mb` 定义档位（如 student=2C4G、default=4C8G、vip=8C16G），`max_*` 做上限校验。磁盘不分档（模板下限，A14）。
- **池水位保护**：宿主 CPU/内存/磁盘使用率 > 85% 时拒绝新分配并告警（返回 429 + 排队位），避免 oversubscribe 把所有人拖慢。
- **并发限流**：DMS 侧并发克隆 ≤ 4、并发开关机 ≤ 8；单用户 `ensure` 请求 10s 内只允许 1 次（防狂点）。
- 配额超限行为：只告警不强制关机（避免打断正在工作的用户）；强制策略只在 `max_daily_hours` 明显超出时按组织规定执行。

### 9.8 监控告警

| 类别 | 指标 | 告警阈值 |
|---|---|---|
| 池容量 | 宿主 CPU/内存/磁盘使用率、可用 IP 数、活跃实例数 | >85% / IP <10% / 实例数接近上限 |
| 创建链路 | `ensure` P50/P95 耗时、失败率、各 stage 耗时 | P95 >180s；失败率 >5% |
| 探针 | 3389 探测失败数、`probe_fail_count`、Agent 未就绪时长 | 单实例连续 3 次失败；整批 >10% 失败 |
| Guacamole | 活跃会话数、authToken 换取失败率、guac_db 连接数 | 换取失败率 >10% |
| 文件服务器 | SMB 可用性、`C:\workspace` 可用空间、SFTP 推送失败率 | 不可用 / <15% 空间 |
| 任务队列 | `pending` 堆积数、最老任务等待时长、`failed` 数 | 堆积 >20；等待 >10min |
| 审计异常 | `desktop_error`、`desktop_quota_deny` 频次 | 1 小时内 >5 次 |

建议：Prometheus + Grafana（Proxmox 有 exporter；DMS 暴露 `/metrics`），告警接企业微信/钉钉/邮件。**至少先把「创建失败」「池满」「文件服务器不可达」三条 P0 告警接上。**

### 9.9 备份策略

| 对象 | 频率 | 保留 | 备注 |
|---|---|---|---|
| 业务库 `stats_platform` | 每日全量 + WAL 归档 | 30 天 | 现状 |
| `guacamole_db` | 每日全量 | 30 天 | **含明文 RDP 密码（方案 A′ 下即平台密码），加密存放、单独权限（0600，仅 dba 组可读）** |
| 文件服务器用户数据 | 每日增量 + 每周全量 | 90 天 | 现状 |
| VM 模板 | 每次变更前快照 | 最近 5 份 | Proxmox 快照/模板导出 |
| VM 差分盘 | 不备份（无状态） | — | 数据在文件服务器 |
| 录像 | 连续 | 180 天 | 大小评估：每人每小时 50~200MB |

### 9.10 故障恢复

| 故障 | 恢复动作 | RTO |
|---|---|---|
| 单台 VM 蓝屏/无响应 | DMS 自动 `reset`；失败则从快照恢复；再失败则重建（数据不丢） | 5~15 min |
| 单台宿主宕机 | Proxmox HA（若配置）自动迁移；否则手动在其他宿主重建实例（数据不丢） | 15~60 min |
| 整个 Proxmox 集群不可用 | 切 `DESKTOP_MODE=rds`，全员回应急共享 RDS（老主机仍在） | 分钟级 |
| Guacamole/guacd 不可用 | 重启容器；Docker `restart: always` 已兜底 | 分钟级 |
| 文件服务器不可用 | **P0**：VM 可进但无数据。恢复文件服务器优先；期间禁止导出操作 | — |
| DMS 不可用 | 已就绪的 VM 仍可连（Guacamole 不依赖 DMS）；只影响新分配。修 DMS 即可 | 分钟级 |
| guac_db 损坏 | 从备份恢复；期间 `/session/connect` 走现有 503 分支（不降级为共享连接） | — |
| 数据误删 | 文件服务器备份恢复 + VM 快照回滚 | 小时级 |

> **关键设计原则**：DMS 不处于「用户已连上桌面之后」的关键路径上——DMS 挂了，已经开着的桌面不受影响。这一点必须在实现时保证（Guacamole 只读 guac_db，不调 DMS）。

---

## 10. 实施路线图

| 阶段 | 目标 | 关键产出 | 退出标准（DoD） |
|---|---|---|---|
| **1. 项目阅读与确认** | 对齐现状、补齐缺失信息 | 本文档 + Q1~Q10 确认结果 | Q1/Q2/Q3（规模、软件授权、Windows 授权）有明确答案 **✅ 2026-11-02 已达成（Q1~Q10 按默认值确认，见第 1 章）** |
| **2. 架构评审** | 定稿架构与选型 | 评审通过的架构图、选型结论、成本估算 | 决策人签字；授权成本已核算 |
| **3. 模板制作** | 做出可克隆的黄金镜像 | Windows Server 2022 模板 VM：装统计软件、`login.ps1` + `software-registry.json`、OpenSSH、QEMU Guest Agent、关 NLA + `SecurityLayer=1`、防火墙规则、`software-registry` 版本登记 | 手动克隆 1 台 → 开机 → RDP 可连 → W:/Z:/pending 正确 → 软件可启动 → 关机转模板成功 |
| **4. 虚拟化平台接入** | Provider 打通 | Proxmox 集群（或 ECS 可用区）、API token、网段/VLAN、IPAM、与 Linux 服务器的隧道 | 脚本能完成「克隆→开机→取 IP→探 3389→销毁」全流程，耗时 <90s |
| **5. DMS 开发（核心）** | 生命周期 + 绑定 + 注册 | `desktop_*` 表（7 张）+ `DesktopProvider` + 任务队列 + worker + 基础 API | 单用户能完成 5.2 的全流程；所有步骤幂等；失败有明确错误码 |
| **6. Guacamole 连接自动注册** | 改造 `src/integrations/guac.ts::buildRdpParameters` | `hostname/port` 参数化；新增 `updateConnectionTarget()` / `revokeConnectionRead()`；`guac_connection_map` 写入；`params_hash` 免重复同步 | 同一用户换 VM 后，下次 connect 自动指向新 IP；回滚写回 `rdsHost` 验证通过；**改密后 `guacamole_user` 密码未被连接参数覆盖** |
| **7. 用户门户改造** | 前端异步化 + 管理页 | `Dashboard.vue` 轮询/进度；`/admin/desktops` 管理页 | 前端在 `rds` 模式下行为不变（向后兼容）；`vm` 模式下有进度与失败提示 |
| **8. 单用户 POC** | 端到端跑通 1 人 | 内部账号完整走一遍 8.5 的 10 项验证 | 10 项全绿；审计链完整 |
| **9. 小范围灰度** | 5% → 20% | `users.desktop_mode='vm'` 分批；每档观察 3 个工作日 | 无 P0/P1 故障；创建 P95 <180s；用户反馈无阻断性问题 |
| **10. 全量切换** | 100% + 老架构降级 | 全体 `desktop_mode='vm'`；`rdsHost` 转为应急共享桌面（仅 admin 可见）；保留 30 天观察期 | 连续 30 天稳定运行；RDS 角色可卸载评估 |
| **11. 运维监控完善** | 可观测 + 自愈 | Prometheus/Grafana + 7 类告警；`reconcile` 对账任务；会话结束回流；录像开启与清理 | P0 告警已接值班；`reconcile` 每日 0 差异；审计报表可导出 |

**并行建议**：阶段 3（模板）与阶段 5（DMS 开发）可并行；阶段 7（前端）应早于阶段 9 完成（向后兼容，可先上线）。

**每个阶段的回滚点**：1~7 全部在「未改变生产行为」状态（`desktop_mode` 默认 `rds`），随时可停；8 之后按 8.6 的分级回滚。

---

## 附录 A：关键代码改动清单（文件级，已按当前 TS 仓库校准）

### A.1 必改（缺一项就出故障）

| 文件 | 改动类型 | 具体说明 |
|---|---|---|
| `src/integrations/guac.ts` | **改** | ① `buildRdpParameters` 增加 `target?: {host, port}` 入参（第 69 行，现硬读 `settings.rdsHost/rdsPort`）；② `ensureConnection` 透传 target；③ 新增 `updateConnectionTarget()`；④ 新增 `revokeConnectionRead()` |
| `src/integrations/transfer.ts` | **改** | `connectSsh()`（第 58 行）增加可选 `target?: {host, port, username, privateKeyPath}`；缺省仍读 `settings.sftpHost`，保证现有调用零改动 |
| `src/integrations/windows-account.ts` | **改** | `runRemotePs(script, action, username, target?)`；`buildAccountScript(username, password)` 不变（VM 与文件服务器共用）；⚠️ `buildWorkspaceScript` **只对文件服务器执行**，VM 侧禁止调用 |
| `src/routers/session.ts` | **改** | 加 `desktopMode` 分支；现有同步逻辑原样保留为 `rds` 分支（回滚路径）；新增 `GET /session/status` |
| `src/schemas/index.ts` | **改** | `sessionOutSchema` 补 `task_id / progress / stage / message / poll_interval`（不声明会被序列化器静默丢弃）；**出向一律 `z.string()/.nullable()`，不用枚举** |
| `src/config/env.ts` | **改** | `settingsSchema` 新增 `desktopMode`、`desktopEnabled`、`desktop*`、`proxmox*`；新增键**必须**同时过 `assertKnownDotenvKeys()` 的校验（否则 .env 写了就启动失败） |
| `src/db/schema.ts` | **改** | 追加 7 张 `desktop_*` 表 + `users` 3 列（`desktopMode` / `desktopQuotaId` / `desktopEnabled`）；变更走 `drizzle-kit generate` |
| `src/server.ts` | **改** | 注册 `desktopRoutes`；按配置启动 `startDesktopWorker()`；`shutdown()` 里 `clearInterval` + 等当前任务结束 |
| `powershell/login.ps1` | **改** | `$FileServer` 参数化（第 45 行）；⚠️ 只改这一行不够，见 A.3 |
| `frontend/src/api/session.ts` | **改** | 新增 `getSessionStatus()` |
| `frontend/src/types/index.ts` | **改** | `SessionInfo` 扩展 |
| `frontend/src/views/dashboard/Dashboard.vue` | **改** | `connect()`（第 125-133 行）改为轮询 + 进度 + 就绪后由用户点击进入 |

### A.2 新增

| 文件 | 说明 |
|---|---|
| `src/desktop/index.ts` | `FastifyPluginAsync`，注册 `/desktop/*` 与 `/admin/desktops/*` |
| `src/desktop/provider/types.ts` / `proxmox.ts` | `DesktopProvider` 接口与 Proxmox 实现（`fetch` + token header） |
| `src/desktop/provider/probe.ts` | `probeTcp(host, port, timeoutMs)`（`node:net`）；SSH 探活直接复用 `src/integrations/ssh-probe.ts` |
| `src/desktop/service/ensure.ts` | 幂等「确保桌面就绪」：查实例 → 查配额 → 建任务（含 `pg_advisory_xact_lock`） |
| `src/desktop/service/provision.ts` | clone → start → waitAgent → 建账号 → 探测 → 注册 guac → 写映射（每步幂等） |
| `src/desktop/service/recycle.ts` | 空闲挂起 / 销毁 + 快照 + 释放 IP + `revokeConnectionRead` |
| `src/desktop/service/reconcile.ts` | 对账：Provider 实际 VM ↔ `desktop_vms` 差异修正 |
| `src/desktop/worker.ts` | `setInterval` + `FOR UPDATE SKIP LOCKED` 消费 `desktop_tasks`；启动时重置 stale `running` |
| `src/db/schema.desktop.ts` | 7 张表的 Drizzle 定义（也可直接并入 `schema.ts`，二选一，不要两处都写） |
| `frontend/src/views/admin/DesktopManage.vue` | 实例/模板/配额/任务四个 Tab |
| `tests/ts/desktop-*.test.ts` | 见 A.4 |

### A.3 容易被漏掉的 PowerShell 硬编码（共 4 处）

| 文件 | 位置 | 现状 | 多 VM 后 |
|---|---|---|---|
| `powershell/login.ps1` | 第 45 行 | `$FileServer = "\\127.0.0.1"` | 改为文件服务器名（参数/注册表/随模板固化） |
| `powershell/enforce-output-location.ps1` | 注释与位置栏配置 | `\\127.0.0.1\pending\<用户名>` / `\\127.0.0.1\StatsData` | 同步改为文件服务器名 |
| `powershell/setup-workspace-drive.ps1` | 第 94 行 | `net use W: \\127.0.0.1\workspace\%USERNAME%` | 同上 |
| `powershell/setup-sftp-datadrive.ps1` | 第 148 行 | `net use Z: \\127.0.0.1\StatsData` | 同上 |

> 注意：`README.md` 第 318 行已经写了「多机部署时改用共享路径」，说明设计意图早就预留了；
> 但**脚本内部**的默认值还没跟上 —— 改的时候四个文件要一起改，漏一个就会出现「W: 有、Z: 没有」这类半残状态。
> 另外 `GUAC_*`/`PS_LOGIN_SCRIPT` 里已有 `psLoginScript` 默认指向 `\\fileserver\scripts\login.ps1`，可作为统一入口。

### A.4 测试（vitest + PGlite，必须保持现有 372 用例全绿）

| 测试点 | 说明 |
|---|---|
| `buildRdpParameters` 带 target | hostname/port 来自入参；不带 target 时回落 `settings.rdsHost`（回归保护） |
| `updateConnectionTarget` 幂等 | 连续调用两次，`guacamole_connection_parameter` 无重复行、`guacamole_user` 密码未变 |
| `revokeConnectionRead` | READ 权限删除，其它用户的连接不受影响 |
| 并发 `ensure` | 同用户两次并发 → 只建 1 条 `desk_instances`、返回同一 `task_id` |
| 任务队列 | `SKIP LOCKED` 下两个 worker 不重复领取；stale `running` 被重置 |
| 配额拒绝 | 超配额返回 429 且不产生任何 VM 记录 |
| 回滚 | `desktop_mode` 切回 rds 后，连接 hostname 写回 `rdsHost` |
| 出向序列化 | 构造 `stage='weird-value'` 的响应，确认不 500（防止重演"出向 schema 收紧"事故） |

> 单语言要求：本仓库已是 **TS 单实现**，不存在「两边都要写」。但每个改动都必须过
> `npm run typecheck && npm run lint && npm test`，且**新增出向 schema 必须做序列化回归**。

## 附录 B：本方案的假设清单（2026-11-02 用户确认：全部按默认值执行）

1. 用户继续通过浏览器访问，Guacamole 继续做网关，继续使用 JDBC（PostgreSQL）数据库认证。
2. 桌面操作系统为 **Windows Server 2022**（与现状一致），协议 **RDP 3389**。
3. 虚拟化平台默认 **Proxmox VE 8.x**；无域（工作组）。
4. 并发规模 30，注册用户 100~300；单桌面**基线规格** 4C/8G/120GB，按 `desktop_quotas.default_*` 分档覆盖（v2.1，A12）。
5. 用户数据留在**中心文件服务器**（原 RDS 主机降级承担），桌面 VM 无状态。
6. 桌面**首次连接时懒创建**，长期绑定；空闲 7 天挂起、30 天销毁（数据不丢）。
7. **密码模型采用方案 A′：VM 本地账号 / 文件服务器账号 / Guacamole 登录三者同密码 = 平台密码**，开启 `GUAC_RDP_AUTO_LOGIN`；接受 guac 库明文存储的既有风险（配合库隔离加固）。改密需四端同步（含 VM）。
8. 不引入 Redis/消息队列，任务队列用 PostgreSQL `SKIP LOCKED`；**DMS 不新增进程**，随主应用起停。
9. 已有阿里云 Linux 服务器继续承载 Guacamole + PostgreSQL + 后端，与 Proxmox 内网通过隧道打通。
10. Windows / RDS CAL / 统计软件授权**已具备多实例合规条件**（Q2/Q3 需最终确认，否则成本与选型结论需重算）。
11. 不引入 Active Directory；若后续引入，密码模型可解耦为方案 B。

---

## 附录 C：TS 侧硬约束清单（每条都是踩过的坑，新代码必须遵守）

| # | 约束 | 为什么会踩 | 本次改造中的落点 |
|---|---|---|---|
| C1 | **响应字段必须在 zod 出向 schema 里声明** | Fastify 用 schema 编译序列化器，未声明的键**静默丢弃**（pydantic 不会） | `sessionOutSchema` 必须补 5 个新字段 |
| C2 | **出向 schema 绝不能比实际产出更严** | 序列化器遇不匹配值是**运行时抛 TypeError**，整个端点 500（已踩 3 次：filters 存量脏数据、time_range 元组、日期列 type/control） | `stage`/`status`/`message` 一律用宽类型，不用 enum |
| C3 | **`z.tuple` 里带 `format` 的元素会被展开成无顶层 `type` 的 `anyOf`**，`fast-json-stringify` 的元组分支必抛 | 出向 `time_range` 已因此改成 `z.array` | 新字段不要用 tuple |
| C4 | **`filters` 这类用户可控键名要防 `__proto__` 原型污染**，入向 schema 统一 `.strict()` | 已有先例 | 新增的 `stage`/`mode` 等查询参数同样 `.strict()` |
| C5 | **wire 层 JSON 键名必须 snake_case** | 前端是 Vue，改成 camelCase 直接断 | `/desktop/ensure` 返回 `task_id`/`guac_url`/`poll_interval`，不是 camelCase |
| C6 | **`.env` 未知键会阻断启动**（`assertKnownDotenvKeys`，复刻 pydantic 的 `extra=forbid`） | 历史上 `.env` 残留 `RSTUDIO_PATH` 导致全站起不来 | 新增 `DESKTOP_*`/`PROXMOX_*` 必须先加进 `settingsSchema` |
| C7 | **`settings` 是可变单例，消费方禁止解构** | `const { jwtSecret } = settings` 会绕开 `overrideSettings`，测试改不生效 | 新模块统一 `getSettings().xxx` |
| C8 | **`app.withDb` 独占一个 PoolClient 并显式 `BEGIN`** | 长任务放进去会长期占连接 + 持事务 | `/desktop/ensure` 内只做毫秒级操作，克隆走 worker |
| C9 | **`src/services/jobs.ts` 是内存队列，重启即丢** | 无持久化、并发上限 2 | 不复用；用 `desktop_tasks` + `SKIP LOCKED` |
| C10 | **一次性脚本必须动态 import `src/**`** | `settings` 是模块级 fail-fast，import 瞬间就校验 | 写迁移/对账 CLI 时先设 `process.env` 再 `await import()` |
| C11 | **用 `findRepoRoot()` 找仓库根，别写死 `new URL('..')`** | 构建态 `dist/src/server.js` 会算成 `<root>/dist`，曾致 `/login` 全量 500 | 新模块若需读仓库内文件，复用 `server.ts` 的 `findRepoRoot` |
| C12 | **`guac.ts` 的连接池按 URL 缓存，池 `max: 5`** | 换池不比对 URL 会静默写错库 | worker 复用同一池，不另建 |

### 一条额外的运维提醒

`src/server.ts` 的 `PROD_CORS_ORIGINS` 是**硬编码域名**。同进程方案下不受影响；
但如果将来把 DMS 拆成独立域名的服务，记得同步改这里 —— 否则前端会拿到看似"登录失效"的 CORS 错误。


