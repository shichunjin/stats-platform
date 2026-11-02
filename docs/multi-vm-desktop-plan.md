# 统计软件托管平台 · 多虚拟机（云桌面）改造方案

> 文档性质：基于**当前仓库代码与配置的实测阅读**产出，不是凭描述空想的架构。
> 阅读范围：`README.md`、`SECURITY_AUDIT.md`、`guacamole/*`、`nginx/*`、`powershell/*`、
> `app/{config,models,guac,guac_token,windows_account,transfer,routers/session}.py`、
> `src/{config/env,db/schema,integrations/guac,integrations/guac-token,services/platform-config}.ts`、
> `frontend/src/api/session.ts`、`frontend/src/views/dashboard/Dashboard.vue`。
> 生产 `.env` 含真实密钥与主机地址，**不在本文档中引用任何真实 IP/域名/口令**。

---

## 0. 结论摘要（先看这段）

| 问题 | 结论 |
|---|---|
| 改造可行性 | **可行，且改造面比想象中小**。因为平台已经做到了「一人一 Guacamole 连接 + 一人一 Windows 账号 + 一人一私有目录」，这套模型天然可以平移到「一人一 VM」。 |
| 最小改动点 | `app/guac.py :: _build_rdp_parameters()` 里写死的 `settings.rds_host / rds_port`，改成从新表读取的「该用户 VM 的 IP/端口」。**一行数据源替换**，其余 Guacamole 注册逻辑（建连接、全量重写参数、授 READ 权限）全部复用。 |
| 最大改造点 | `/session/connect` 必须**从同步改异步**（VM 克隆/开机是分钟级），前端从「拿到 url 直接 `window.open`」改成「提交分配请求 → 轮询状态 → 就绪后打开」。 |
| 最大风险（非技术） | **Windows / RDS CAL / 统计软件授权成本随 VM 数量线性放大**。共享 RDS 时代是 1 份，多 VM 时代是 N 份。这是本项目改造的**头号决策点**，必须先确认。 |
| 默认虚拟化选型 | **Proxmox VE（自建私有云）为默认推荐**；若不愿自建物理机/无运维人力，则选**阿里云 ECS 按量实例**（与现有资产同栈）。理由见第 4 章。 |
| 数据放哪 | **强烈建议「桌面 VM 无状态化 + 数据留在文件服务器」**（即 W:/Z:/pending 仍走 SMB 共享，`login.ps1` 只把 `\\127.0.0.1` 换成文件服务器名）。这样后端 SFTP 推送/回拉、导出审核、审计链路**零改动**，VM 可随时销毁重建。 |
| 是否新增服务 | **是**，新增「云桌面管理服务」（下称 DMS）。但建议**先做成一个独立进程 + 独立库表**，不强耦合现有 `app/`，避免把主站拖进分钟级阻塞。 |

---

## 1. 缺失信息清单（需你确认；未确认前以下按「默认假设」推进）

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

> 上述 Q1/Q2/Q3 如与假设不符，第 4 章的选型结论需要重算；其余项不符只影响实现细节，不影响架构方向。

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
2. 登录成功后 `app/guac_token.py::remember_login_token()`：**用本次明文密码**调 Guacamole `POST /api/tokens` 换 `authToken`，存 `guac_auth_tokens`（TTL 默认 3540s，与 compose 的 `API_SESSION_TIMEOUT=60` 配套）。**只存令牌不存密码**。
3. 用户在仪表盘点「连接数据分析PC」→ 前端 `connectSession()` → `POST /session/connect`。
4. 后端 `routers/session.py::connect_session()`：
   - best-effort 调 `provision_user_workspace(username)`（SSH 到 Windows 幂等补建 W:/pending 目录）；
   - `get_user_connection_id(username)` 查 `guacamole_connection WHERE connection_name='windows-{username}'`；查不到则 `ensure_user_connection()` 补建；
   - **未配置 `GUAC_DB_URL` 时直接 503**（安全修复 A4：拒绝回退到共享连接，防会话串号）；
   - 写 `sessions` 行 + `audit_logs(action='session_connect')`；
   - 拼 `guac_url = {GUACAMOLE_URL}{connection_id}`，令牌有效则追加 `?token=...`。
5. 前端 `window.open(res.guac_url,'_blank')` → Guacamole 免密直连 → guacd → RDP → Windows 登录（默认 `guac_rdp_auto_login=False`，用户手工输一次平台密码）。
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
| 账号来源 | **由业务后端写库创建**，不是手工在 Web UI 建。`app/guac.py` 用 `create_engine(settings.guac_db_url)` 直连裸 SQL |
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
| 账号 | Guacamole 连的是**服务器本地账户**，由 `app/windows_account.py` 经 **SSH**（OpenSSH for Windows + 私钥 `~/.ssh/stats_windows`）执行远程 PowerShell 创建/改密；加 `Users(S-1-5-32-545)` 与 `Remote Desktop Users(S-1-5-32-555)`（按 SID，语言无关） |
| 远程执行封装 | PowerShell 脚本 → **UTF-16LE + Base64** → `powershell -NoProfile -Command -` 从 stdin 喂入（绕命令行长度限制与 GBK 代码页问题）。`timeout=25s` |
| 工作区 | `C:\workspace\{u}` 共享为 `workspace`、`C:\pending\{u}` 共享为 `pending`；`icacls /inheritance:r` + 仅本人/SYSTEM/Administrators；SMB `FolderEnumerationMode AccessBased` |
| 数据投递 | `app/transfer.py` SFTP：生成 Excel 推 `C:/StatsData`（Z: 只读），筛选数据推 `C:/workspace/{u}/`（W:）；导出时从 `C:/pending/{u}/` 回拉 |
| 连接目标 | `settings.rds_host` / `rds_port=3389`，**全局单值**，写进每个用户的连接参数 |

### 2.5 用户与权限模型

三层身份 + 三层隔离：

1. **平台层**：`users(id, username, role=user|admin|superadmin, is_active, password_version)`；JWT + 角色守卫（`src/auth/guards.ts`）；限流（`rate_limit.py`，登录 5/60s、注册 3/300s，按 IP）。
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

**配置**：`pydantic-settings`（Python）/ `zod`（TS）+ 自定义 dotenv 解析器（**必须自研**：npm dotenv 会把未加引号值里的 `#` 当注释截断，`GUACAMOLE_URL=.../guacamole/#/client/` 会被截成 `.../guacamole/`，导致 `/session/connect` 拼出 `/guacamole/3` → Tomcat 404）。隐私配置无默认值，缺失即 fail-fast。

### 2.7 现有接口与服务

32 个端点（Python 与 TS 双向零差异）。与本次改造直接相关的：

| 方法 | 路径 | 改造相关度 |
|---|---|---|
| POST | `/auth/register` | 高：注册即同步 guac 用户+连接；多 VM 下是否「注册即预建 VM」是策略选择 |
| POST | `/auth/login` | 中：换 authToken 逻辑不变 |
| POST | `/auth/change-password` | 中：改密需同步 guac 用户密码（且不掌握明文时无法同步连接密码） |
| POST | `/session/connect` | **极高：本次改造主战场** |
| POST | `/data/fetch` | 中：生成 Excel 后 SFTP 推送目标（中心文件服务器方案下不变） |
| POST | `/results/request-export` | 中：SFTP 回拉 pending（中心文件服务器方案下不变） |
| GET | `/admin/*` | 中：需新增桌面管理接口 |
| — | `app/jobs.py`、`src/services/jobs.ts` | 后台任务已存在（生成 Excel 用线程池），可借鉴 |

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
2. **连接参数全量重写**——改 IP/端口是幂等操作，回滚就是把 `hostname` 改回 `rds_host`。
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
| **同步假设** | `login.ps1` 硬编码 `$FileServer = "\\127.0.0.1"`——**文件服务器与桌面必须在同一台机器上** | 多 VM 后必须改成可配置的中心文件服务器 UNC，这是必改项 |
| **同步阻塞** | `/session/connect` 假设「连接立即就绪」（查一次库就有 connection_id） | VM 克隆是分钟级，接口必须异步化 |
| **无 IP/资产管理** | 没有任何表记录「谁的桌面在哪儿、什么状态」 | 需新建 8 张表（第 7 章） |
| **RDP 安全配置张力** | `config.py` 默认 `guac_rdp_security='nla'` + `ignore_cert=False`，而 README 排错章节要求 `security=tls` + 关 NLA + `ignore-cert=true`。二者若不一致会导致协商失败 | 多 VM 后要在**模板**里统一固化（关 NLA + SecurityLayer=1），并把连接参数与模板对齐，避免每台 VM 手工调 |
| **录像未开** | `guac_recording_root` 默认为空 | VM 化后建议开启（审计不降级要求），但需评估存储（每人每小时约 50~200MB） |
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

1. **独立进程**，不塞进现有 `app/` 的请求线程——VM 克隆是分钟级，会让单 worker 主站直接打挂（SEC-16/ARCH-06 已指出单 worker 是可用性单点）。
2. **独立库表**（`desktop_*` 前缀），不动现有 9 张业务表的结构；`users` 只做 `ADD COLUMN`（可回滚）。
3. **只通过三个边界接入现有系统**：① 写 `guacamole_db`（复用 `app/guac.py` 的事务封装）；② 调 Provider API；③ SSH 到目标 VM 执行 PowerShell（复用 `app/windows_account.py::_run_remote_ps` 的编码封装，host 改成动态）。

### 3.3 虚拟机的创建、克隆、分配、回收

| 阶段 | 策略 | 说明 |
|---|---|---|
| **创建时机** | 默认 **懒创建（首次 connect 时）**；管理员可 `POST /admin/desktops/prewarm` 预建池 | 懒创建省资源；预建池把等待时间从 90s 降到 5s |
| **创建方式** | **从模板链接克隆（linked clone）**，不做全新安装 | Proxmox：从模板 VM 做 full/linked clone，秒级~十秒级；ECS：`RunInstances` + 自定义镜像，约 60~180s |
| **分配** | `desk_instances` 上 `(user_id) WHERE status IN (...)` **部分唯一索引**保证一人一活跃桌面；并发用 `pg_advisory_xact_lock(hash(user_id))` | 防重复点按钮开出两台 VM |
| **初始化** | 克隆后：① 开机 ② 等 Guest Agent `guest-ping` 成功 ③ 注入计算机名 `DESK-{username}` ④ SSH 建本地账号（同名同密码/随机密码）⑤ 加入 Remote Desktop Users ⑥ 写 Guacamole 连接 ⑦ RDP 3389 端口探测 | 第 ⑥⑦ 步必须对同一 IP 做「TCP 3389 可连 + 可选 RDP banner 探测」 |
| **复用** | 已存在 `status='ready'` 的实例 → 若 `power_state='stopped'` 则开机并重新探测 → 直接返回连接 | 不做重新克隆 |
| **回收** | 三档策略，可配：`idle_suspend_days=7`（挂起，内存释放）、`idle_destroy_days=30`（销毁 VM，保留用户数据盘/快照）、`max_lifetime_days=180`（强制重建） | 数据盘在文件服务器，销毁 VM 不丢数据 |
| **回收执行** | DMS 定时任务每 10 分钟扫描 `last_disconnected_at`，写 `desktop_tasks(type='recycle')` 串行执行 | 销毁前先 `shutdown`（优雅）+ 快照（可选）+ 释放 IP + 删除 guac 连接映射 |

### 3.4 Guacamole 连接如何自动注册

**核心原则：复用现有 `app/guac.py`，只改数据源。** 流程（DMS 内，一个事务）：

```python
# 现有：params["hostname"] = settings.rds_host          <-- 写死的全局常量
# 改为：params["hostname"] = vm.primary_ip              <-- 来自 desktop_vms 表
```

```
begin tx (guacamole_db):
  entity_id      = ensure_entity(username)                 # 不变
  connection_id  = ensure_connection(username, password,
                     host=vm.ip, port=vm.rdp_port)         # 仅 hostname/port 改为动态
  grant_read(entity_id, connection_id)                     # 不变，只授本人
commit tx (业务库):
  upsert guac_connection_map(instance_id, connection_id, entity_id, params_hash, synced_at)
```

要点：
- **连接名仍用 `windows-{username}`**，不改前缀 → 免密直连 URL、审计 detail、运维习惯全部不变。
- **参数全量重写**的既有行为正好保证「VM 换了 IP，下次同步即生效」，无需额外清理。
- 连接**不删除**只更新（VM 销毁时可选保留连接并置 `max_connections=0`，或删除）。推荐**保留连接 + 删除 READ 授权**，避免 `guacamole_connection_history` 里的历史记录被 `ON DELETE SET NULL` 抹掉（历史审计价值）。
- **不要用 Guacamole REST API 建连接**：需要 admin token、字段语义与 JDBC 不完全一致、且本项目已有成熟的事务化裸 SQL 实现。REST API 只用于换 authToken（现状如此）。

### 3.5 用户权限如何映射到虚拟机

| 层 | 映射方式 | 是否变化 |
|---|---|---|
| 平台 → Guacamole 连接 | 不变：`windows-{username}` + 仅 READ | 不变 |
| Guacamole 连接 → VM | 新增：`guac_connection_map.instance_id → desk_instances.id → desktop_vms.id` | 新增 |
| 平台账号 → VM 本地账号 | 新增：DMS 在 VM 上建**同名**本地账号；密码策略见下 | 新增 |
| 平台账号 → 文件服务器账号 | 复用：`app/windows_account.py` 目标主机改为文件服务器（保持同名同密码） | 小改 |
| VM → 用户数据 | 不变：SMB `\\fileserver\workspace\{username}` + NTFS ACL + ABE | 仅 UNC 主机变化 |
| 管理员 | 新增 `/admin/desktops*` 只读/操作接口；`role` 判定复用 `src/auth/guards.ts` 逻辑 | 新增接口 |

**认证方式建议（重要权衡）**：

| 方案 | 做法 | 优点 | 缺点 | 建议 |
|---|---|---|---|---|
| A. 沿用现状 | VM 本地账号密码 = 平台密码，`guac_rdp_auto_login=False`，用户手工输一次 | 零明文入库（B13 修复保住） | 用户体验差；VM 专属场景下「防串号」收益消失，却仍要输密码 | 可作为回退 |
| **B. 每 VM 随机强密码 + 开启 auto-login（推荐）** | DMS 生成 32 位随机密码，同时下发到 VM 与文件服务器；写入 Guacamole 连接参数 | 一键直连；密码与平台密码解耦（改平台密码不再需要同步 VM）；VM 是专属的，明文泄露**只能进自己的 VM** | `guacamole_connection_parameter` 明文存密码（guacamole-auth-jdbc 已知设计） | **推荐**，配套加固见第 9 章 |
| C. 引入 AD/LDAP | Guacamole 走 LDAP，VM 加域 | 最规范，ACL 用域账号 | 改动最大，需域控 | 中期目标 |

选 B 时仍需遵守现有约束：**guacamole_db 只监听 127.0.0.1**（现状已如此）、磁盘加密、dump 单独保管。

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
| Python/TS 双实现对齐的门禁 | 100%（新模块两边都要写） |

### 3.8 哪些部分必须修改

| 文件 / 模块 | 修改 |
|---|---|
| `src/integrations/guac.ts :: buildRdpParameters()` | `hostname/port` 从 `settings.rdsHost` 改为入参（来自 VM 记录）；增加 `username/password` 可选注入（方案 B） |
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

### 4.3 参考规模估算（默认 30 并发，4C/8G/120GB/用户）

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
| 4 | 查 `desk_instances WHERE user_id=? AND status IN (就绪态)` | DMS | 1s | 无 → 走 5 |
| 5 | **有实例**：若 `power_state != running` → 开机 → 等 Agent 就绪 → 探测 3389 | DMS | 120s | 见 5.3 |
| 5' | **无实例**：检查配额 → 选模板 → 分配 IP → **克隆** → 建任务 | DMS | — | 见 5.3 |
| 6 | 克隆完成后：开机 → 等 `guest-ping` → SSH 建本地账号（同名同密码）+ 加 Remote Desktop Users + 设置静态 IP（或读回 DHCP IP） | DMS | 300s | 见 5.3 |
| 7 | 回写 `desktop_vms.primary_ip/port/protocol/guest_username` | DMS | — | — |
| 8 | **Guacamole 注册**：事务内 ensure entity → ensure connection（hostname=VM IP）→ grant READ | DMS | 10s | 见 5.3 |
| 9 | 写 `guac_connection_map`（幂等 upsert） | DMS | — | — |
| 10 | 返回 `{status:'ready', guac_url, instance_id}`；未就绪返回 `{status:'provisioning', task_id, progress, poll_interval}` | DMS | — | — |
| 11 | 前端轮询 `GET /session/status?task_id=...`（建议 2s 间隔，最长 5min） | 前端 | 300s | 超时提示重试/联系管理员 |
| 12 | 就绪后 `window.open(guac_url,'_blank')`（**必须用户点击触发**，否则被浏览器拦截） | 前端 | — | — |
| 13 | Guacamole 免密直连 → guacd → RDP → VM 桌面 → `login.ps1` 挂载 W:/Z:/pending | — | — | — |
| 14 | 写 `audit_logs(action='session_connect', detail='... vm_id=.. ip=..')` + 更新 `desk_instances.last_connected_at` | DMS | — | — |
| 15 | 断开后：Guacamole 侧 `guacamole_connection_history` 落库；DMS 定时回流写 `sessions.ended_at` + `audit_logs(action='session_end')`，更新 `last_disconnected_at` | DMS | 每 10min | — |
| 16 | 回收：`idle_suspend_days=7` → 挂起；`idle_destroy_days=30` → 快照 + 销毁 + 释放 IP + 撤销 guac READ | DMS | 每 10min | — |

> **对用户可见的体验目标**：首次点击 ≤ 90s 看到 Windows 登录/桌面（Proxmox linked clone + 预置模板可达 30~60s）；二次点击 ≤ 15s（VM 已挂起/关机时的唤醒）或 ≤ 3s（VM 仍在运行）。

### 5.3 前端改造（最小侵入）

```ts
// api/session.ts
export function connectSession() {           // 保持同名，行为变为幂等的「确保桌面就绪」
  return request.post<unknown, SessionInfo>('/session/connect')
}
export function getSessionStatus(taskId: string) {
  return request.get<unknown, SessionInfo>(`/session/status?task_id=${taskId}`)
}

// SessionInfo 扩展（向后兼容：guac_url 仍存在）
export interface SessionInfo {
  id: number
  status: 'ready' | 'provisioning' | 'failed' | 'error'
  guac_url?: string | null
  task_id?: string | null
  progress?: number          // 0~100
  stage?: string             // 'clone' | 'boot' | 'config' | 'probe' | 'register'
  message?: string | null    // 面向用户的中文提示
  launched_at?: string | null
}
```

`Dashboard.vue` 的 `connect()` 改为：调接口 → 若 `status==='ready'` 直接 `window.open`；否则显示进度条并轮询，**就绪后提示用户点击「进入桌面」再 open**（避免弹窗被拦截）。

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

| 项 | 选择 | 理由 |
|---|---|---|
| 语言/框架 | **首选 Python FastAPI**（与现役 `app/` 一致）；若已决定全量切 TS，则写在 `src/` 下用 Fastify | 生产是 Python，运维/排障心智统一；抽象为独立进程后，后续随 TS 迁移整体重写也不影响 |
| ORM | SQLAlchemy（Python）/ Drizzle（TS），**只管 `desktop_*` 表** | 与现有栈一致 |
| Guacamole 库访问 | 复用 `app/guac.py` 的事务封装（或 `src/integrations/guac.ts`），**裸 SQL** | guacamole_* 表不在 ORM 内（现状如此） |
| 任务队列 | **PostgreSQL `SELECT ... FOR UPDATE SKIP LOCKED`**（默认，零新组件）；规模大时换 Celery/RQ + Redis | 不引入新中间件（Q10 假设） |
| Provider 客户端 | `proxmoxer`（Python）/ 自写 fetch 封装；阿里云用官方 SDK | 抽象成 `DesktopProvider` 接口 |
| 远程执行 | 复用 `paramiko`/`ssh2` + UTF-16LE Base64 PowerShell 封装（**host 参数化**） | 现有封装已解决中文 Windows 编码问题 |
| 部署 | **独立 systemd 服务** `desktop-service`（API）+ `desktop-worker`（1~2 个 worker 进程）；Nginx 反代 `/api/desktop` | 独立进程，崩溃不影响主站 |

### 6.2 部署方式

```ini
# /etc/systemd/system/desktop-service.service
[Unit]
Description=Stats Platform Desktop Management Service
After=network.target postgresql.service

[Service]
Type=simple
User=stats
WorkingDirectory=/opt/stats-platform
Environment=APP_ENV=prod
ExecStart=/usr/bin/node /opt/stats-platform/dist/src/desktop-server.js
Restart=always
RestartSec=3
MemoryMax=1G

[Install]
WantedBy=multi-user.target
```

```nginx
# nginx-stats-platform.conf 追加
location /api/desktop/ {
    proxy_pass http://127.0.0.1:8100/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 120s;     # 分配接口最长 90s
}
```

- 与业务库/Guacamole 库同机或同内网；**Guacamole 库账号只给 DMS 与业务后端**。
- Worker 数量 = 2（避免并发克隆打爆存储；Proxmox 侧并发克隆建议 ≤ 4）。
- 所有 Provider 调用集中在一处，便于限流与审计。

### 6.3 Provider 抽象接口

```python
class DesktopProvider(Protocol):
    def validate_template(self, tpl: DesktopTemplate) -> bool: ...
    def clone(self, tpl: DesktopTemplate, name: str, spec: VmSpec) -> str:   # 返回 provider_ref(vmid/instanceId)
    def start(self, ref: str) -> None: ...
    def stop(self, ref: str, graceful: bool = True) -> None: ...
    def suspend(self, ref: str) -> None: ...
    def reset(self, ref: str) -> None: ...
    def destroy(self, ref: str) -> None: ...
    def snapshot(self, ref: str, name: str) -> str: ...
    def restore(self, ref: str, snap: str) -> None: ...
    def power_state(self, ref: str) -> str: ...
    def wait_agent_ready(self, ref: str, timeout: int) -> None: ...
    def guest_ip(self, ref: str) -> str | None: ...
    def host_capacity(self) -> Capacity: ...      # 用于资源不足判定
```

**Proxmox 实现要点**（实测可用的调用序列）：

```bash
# 1) 从模板链接克隆（vmid 由 DMS 从 9000+ 段分配）
POST /api2/json/nodes/{node}/qemu/{tpl_vmid}/clone
     newid=9101&name=DESK-alice&full=0&target={node}&storage={storage}
# 2) 设置静态 IP（cloud-init）或注入首次启动脚本
PUT  /api2/json/nodes/{node}/qemu/9101/config
     ipconfig0=ip=10.20.3.11/16,gw=10.20.0.1
     ciuser=Administrator&cipassword=<随机>
# 3) 开机
POST /api2/json/nodes/{node}/qemu/9101/status/start
# 4) 等 Agent（QEMU Guest Agent 必须预装在模板里）
GET  /api2/json/nodes/{node}/qemu/9101/agent/ping     # 轮询直到成功，超时 180s
# 5) 回读 IP（若用 DHCP）
POST /api2/json/nodes/{node}/qemu/9101/agent/network-get-interfaces
# 6) 探活（DMS 侧）
nc -z -w3 10.20.3.11 3389 ; nc -z -w3 10.20.3.11 22
```

Windows 模板必须预装 **QEMU Guest Agent**（virtio-win ISO 自带）+ **OpenSSH Server** + **Cloudbase-Init**（可选，用于计算机名/静态 IP）。

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
| 认证 | 复用现有 JWT（`JWT_SECRET` 共享，`app/auth.py::get_current_user` 逻辑平移）；DMS 不独立发令牌 |
| 用户信息 | **只读 `users` 表**，不复制用户数据（避免双写不一致） |
| 审计 | 写入现有 `audit_logs`（新增 action），管理员 `/admin/audit` 直接可查 |
| 注册/改密联动 | 注册时不建 VM（懒创建）；改密时若已存在 VM 且采用方案 A（密码=平台密码），DMS 收到事件后 SSH 同步改 VM 与文件服务器账号；**方案 B（随机密码）则完全不需要联动** |
| 账号停用 | `users.is_active=false` → DMS 定时任务挂起/销毁其桌面 + 撤销 guac READ |
| 数据投递 | 不变（文件服务器）；DMS 不参与 `transfer.py` 逻辑 |

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
  vcpu                     integer      NOT NULL,
  memory_mb                integer      NOT NULL,
  disk_gb                  integer      NOT NULL,
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

| 级别 | 开关 | 用途 |
|---|---|---|
| 全局 | `DESKTOP_MODE=rds|vm|hybrid` | `rds`=全量老架构；`vm`=全量新架构；`hybrid`=按人判定 |
| 用户 | `users.desktop_mode` | 白名单用户走 VM，其余走 RDS |
| 会话 | 请求参数 `?mode=vm`（仅管理员/测试） | 临时验证 |

推进节奏：**内部账号（1~2 人）→ 志愿者 5% → 20% → 50% → 100%**，每档观察 ≥ 3 个工作日。

灰度判定代码位置：`/session/connect` 开头：

```python
mode = user.desktop_mode if settings.desktop_mode == 'hybrid' else settings.desktop_mode
if mode == 'rds':
    <走现有共享 RDS 分支>（保留！这就是回滚路径）
else:
    <走 DMS ensure 分支>
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

### 8.6 如何回滚

| 层级 | 回滚动作 | 耗时 | 影响 |
|---|---|---|---|
| 单用户 | `UPDATE users SET desktop_mode='rds' WHERE id=?` + 触发一次连接重新注册（hostname 改回 `rds_host`） | 秒级 | 该用户下次连接回到共享 RDS，数据不受影响 |
| 批量 | `UPDATE users SET desktop_mode='rds' WHERE id IN (...)` | 秒级 | 同上 |
| 全局 | 改 `.env` `DESKTOP_MODE=rds` + 重启（或热加载） | 秒级~分钟 | 全体回共享 RDS |
| 完全下线 DMS | 停 systemd 服务，注释 Nginx `/api/desktop/` 段 | 分钟级 | 回到改造前 100% 状态 |

**回滚之所以能秒级完成，靠的是 `_ensure_connection()` 的「参数全量重写」**：把 `hostname` 写回 `rds_host` 即可，不需要删连接、不需要动用户、不需要动权限。

### 8.7 如何避免一次性停机

- 老 RDS 主机全程在线（它就是文件服务器 + 应急桌面），新 VM 并行接入，**不存在切换窗口**。
- 数据库只做 `ADD COLUMN`（PostgreSQL 11+ 带默认值加列是元数据操作，秒级，不锁表重写）。
- 前端改造**向后兼容**：`/session/connect` 在 `rds` 模式下仍同步返回 `guac_url`，前端轮询逻辑只在收到 `status='provisioning'` 时启用。可先上前端、后上 DMS。
- 新表全部 `CREATE TABLE IF NOT EXISTS` 风格，可提前建好，不影响现有请求。

### 8.8 如何处理旧 RDS 连接

1. **保留**：`windows-{username}` 连接继续存在，灰度期间 hostname 在 `rds_host` 与 VM IP 之间切换。
2. **全量切换后**：`rds_host` 语义变为「应急共享桌面」，创建一个 `SHARED-EMERGENCY` 连接（**只对 admin 可见**），供文件服务器维护/VM 池故障期间临时使用。
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
- 密码策略（推荐方案 B）：**每 VM 32 位随机强密码**，由 DMS 生成并下发到 ① VM 本地账号 ② 文件服务器同名账号 ③ Guacamole 连接参数。与平台密码解耦。
  - 若坚持方案 A（= 平台密码），则改密时必须同步三端，失败要整体回滚（现有 `upsert_guac_user` 的事务语义可借鉴）。
- **Administrator 账号**：模板内禁用或改随机密码并封存；DMS 用独立的管理通道（SSH + 专用密钥）维护，密钥只放 DMS 主机。
- SSH：仅密钥认证，禁用密码认证；`~/.ssh/authorized_keys` 只放 DMS 公钥；**必须开启主机密钥校验**（SEC-08 指出当前无校验，新链路要修正）。
- 密码永不过期开关沿用 `windows_password_never_expires`（默认 False）；VM 场景下建议置 True 并改为「VM 生命周期内有效」，避免 42 天后集体登录失败。

### 9.3 Guacamole 权限控制

- 保持「一人一连接 + 仅授本人 READ」；**不授予 UPDATE/DELETE/ADMINISTER**。
- 不给任何普通用户 `CREATE_CONNECTION` 等系统权限（现状如此）。
- `guacadmin` 超级管理员：改强密码、**考虑禁用或改名为非默认名**（`initdb.sql` 默认 `guacadmin/guacadmin`，README 也提示首登改密）。
- `guacamole_db` 只监听 127.0.0.1（现状），并单独备份、单独授权。
- 开启会话录像（`GUAC_RECORDING_ROOT`）后，录像目录按用户隔离、权限 0700，并设置保留期（建议 180 天）。

### 9.4 防止用户访问他人虚拟机

四道防线（缺一不可）：

1. **Guacamole 层**：连接权限只有本人 READ，看不到、点不到别人的连接（现状已实现）。
2. **账号层**：每台 VM 只有本人账号（+封存的 Administrator），且密码随机互不相同。即使猜到 IP 也没有凭据。
3. **网络层**：VM 之间互不可达 3389；用户无法从 VM 内发起对其他 VM 的 RDP。
4. **数据层**：文件服务器 SMB ABE + NTFS ACL（现状），`\\fileserver\workspace\` 下只能看到自己的目录。
5. **附加**：VM 内不暴露内网网段扫描能力（禁 `ping` 出网可选）；审计里记录每个用户实际连的 `vm_id` + IP，便于事后追溯。

### 9.5 快照与数据回收

| 对象 | 策略 |
|---|---|
| 用户数据 | **在文件服务器，不在 VM**。VM 销毁不影响数据。文件服务器侧按现有备份策略（每日增量 + 每周全量） |
| VM 快照 | 销毁前自动打一份快照，保留 30 天后自动清理；重建时可选择回滚到该快照 |
| 模板快照 | 每次模板更新前打快照，命名含日期与 `software-registry` 版本；保留最近 5 份 |
| 回收流程 | `idle 7d` → 挂起（释放内存，保留磁盘）→ `idle 30d` → 快照 + 优雅关机 + 销毁 + 释放 IP + 撤销 guac READ + 写 `desktop_recycle` 审计 |
| 数据销毁合规 | 用户销号时：销毁 VM + 快照；文件服务器目录按组织留存策略处理（建议保留 N 天后安全擦除），并写审计 |

### 9.6 审计日志

- 复用 `audit_logs` + 新增 action（7.7），保证 `/admin/audit` 一处可查。
- 新增**会话结束回流**：定时（每 10 分钟）从 `guacamole_connection_history` 读取 `end_date` 非空的记录，写 `sessions.ended_at` 与 `audit_logs(action='session_end', detail='duration_sec=..')`。
- 建议补：桌面实例维度可导出「谁在什么时候用了哪台 VM、多久」的报表（合规检查常用）。
- 日志保留：在线 1 年 + 归档 3 年；`audit_logs` 按月分区（量大时）。

### 9.7 资源配额

- 默认配额见 `desktop_quotas`（7.6）：`max_instances=1`、`max_idle_days=7`、`destroy_after_idle_days=30`、`rebuild_after_days=180`。
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
| `guacamole_db` | 每日全量 | 30 天 | **含明文 RDP 密码（方案 B 时），加密存放、单独权限** |
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
| **1. 项目阅读与确认** | 对齐现状、补齐缺失信息 | 本文档 + Q1~Q10 确认结果 | Q1/Q2/Q3（规模、软件授权、Windows 授权）有明确答案 |
| **2. 架构评审** | 定稿架构与选型 | 评审通过的架构图、选型结论、成本估算 | 决策人签字；授权成本已核算 |
| **3. 模板制作** | 做出可克隆的黄金镜像 | Windows Server 2022 模板 VM：装统计软件、`login.ps1` + `software-registry.json`、OpenSSH、QEMU Guest Agent、关 NLA + `SecurityLayer=1`、防火墙规则、`software-registry` 版本登记 | 手动克隆 1 台 → 开机 → RDP 可连 → W:/Z:/pending 正确 → 软件可启动 → 关机转模板成功 |
| **4. 虚拟化平台接入** | Provider 打通 | Proxmox 集群（或 ECS 可用区）、API token、网段/VLAN、IPAM、与 Linux 服务器的隧道 | 脚本能完成「克隆→开机→取 IP→探 3389→销毁」全流程，耗时 <90s |
| **5. DMS 开发（核心）** | 生命周期 + 绑定 + 注册 | `desktop_*` 表（7 张）+ `DesktopProvider` + 任务队列 + worker + 基础 API | 单用户能完成 5.2 的全流程；所有步骤幂等；失败有明确错误码 |
| **6. Guacamole 连接自动注册** | 改造 `_build_rdp_parameters` | `hostname/port` 参数化；`guac_connection_map` 写入；`params_hash` 免重复同步 | 同一用户换 VM 后，下次 connect 自动指向新 IP；回滚写回 `rds_host` 验证通过 |
| **7. 用户门户改造** | 前端异步化 + 管理页 | `Dashboard.vue` 轮询/进度；`/admin/desktops` 管理页 | 前端在 `rds` 模式下行为不变（向后兼容）；`vm` 模式下有进度与失败提示 |
| **8. 单用户 POC** | 端到端跑通 1 人 | 内部账号完整走一遍 8.5 的 10 项验证 | 10 项全绿；审计链完整 |
| **9. 小范围灰度** | 5% → 20% | `users.desktop_mode='vm'` 分批；每档观察 3 个工作日 | 无 P0/P1 故障；创建 P95 <180s；用户反馈无阻断性问题 |
| **10. 全量切换** | 100% + 老架构降级 | 全体 `desktop_mode='vm'`；`rds_host` 转为应急共享桌面（仅 admin 可见）；保留 30 天观察期 | 连续 30 天稳定运行；RDS 角色可卸载评估 |
| **11. 运维监控完善** | 可观测 + 自愈 | Prometheus/Grafana + 7 类告警；`reconcile` 对账任务；会话结束回流；录像开启与清理 | P0 告警已接值班；`reconcile` 每日 0 差异；审计报表可导出 |

**并行建议**：阶段 3（模板）与阶段 5（DMS 开发）可并行；阶段 7（前端）应早于阶段 9 完成（向后兼容，可先上线）。

**每个阶段的回滚点**：1~7 全部在「未改变生产行为」状态（`desktop_mode` 默认 `rds`），随时可停；8 之后按 8.6 的分级回滚。

---

## 附录 A：关键代码改动清单（文件级）

| 文件 | 改动类型 | 说明 |
|---|---|---|
| `src/integrations/guac.ts` | **改** | `buildRdpParameters(username, password, host, port)` 参数化；新增 `updateConnectionTarget()`；新增 `revokeRead()` |
| `src/integrations/guac-token.ts` | 不改 | — |
| `src/config/env.ts` | 改 | 新增 `desktopMode`、`desktop*`、`provider*` 配置段与校验 |
| `src/routers/session.ts` | **改** | 加 `desktopMode` 分支；新增 `/session/status`；保留 `/session/connect` |
| `src/integrations/windows-account.ts` | 改 | `connectSsh(host)`、`runRemotePs(host)` 参数化 |
| `src/db/schema.ts` | 改 | 新增 7 张 `desktop_*` 表 + `users` 3 列 |
| `src/db/desktop-schema.ts`（新） | 新增 | DMS ORM 模型（或并入 `schema.ts`） |
| `src/desktop/`（新模块） | 新增 | DMS 服务：`index.ts`、`provider/`、`tasks/`、`worker.ts`、`routers/` |
| `powershell/login.ps1` | 改 | `$FileServer` 可配置（`-FileServer` 参数 / 注册表 / 环境变量，默认 `\\127.0.0.1`） |
| `powershell/setup-rdsh.ps1` | 保留 | 用于应急共享主机；模板制作时参考其账号/加组逻辑 |
| `powershell/configure-rds.ps1` | 保留/改 | 模板内仍执行（禁剪贴板/盘/打印）；可并入模板制作 |
| `frontend/src/api/session.ts` | 改 | 新增 `getSessionStatus()`；`SessionInfo` 扩展 |
| `frontend/src/views/dashboard/Dashboard.vue` | 改 | 轮询 + 进度 + 失败提示 |
| `frontend/src/views/admin/*` | 新增 | `DesktopManage.vue`（实例/模板/配额/任务） |
| `guacamole/docker-compose.yml` | 小改 | 如需录像：挂 recordings + 设 `GUACAMOLE_HOME`；版本保持 1.6.0 |
| `nginx/nginx-stats-platform.conf` | 改 | 加 `/api/desktop/` 反代 |
| `README.md` | 改 | 新增「多虚拟机（云桌面）模式」章节与部署步骤 |
| `tests/`（py + ts） | 新增 | Provider mock、并发 ensure 幂等、回滚 hostname、配额拒绝、任务队列 SKIP LOCKED |

> 双语言要求：凡改动 `app/` 的，**`src/` 必须同步改**，保持 32 端点 + 新端点双向零差异，并跑通 `npm run typecheck && npm run lint && npm test`。

## 附录 B：本文采用的默认假设清单

1. 用户继续通过浏览器访问，Guacamole 继续做网关，继续使用 JDBC（PostgreSQL）数据库认证。
2. 桌面操作系统为 **Windows Server 2022**（与现状一致），协议 **RDP 3389**。
3. 虚拟化平台默认 **Proxmox VE 8.x**；无域（工作组）。
4. 并发规模 30，注册用户 100~300；单桌面规格 4C/8G/120GB。
5. 用户数据留在**中心文件服务器**（原 RDS 主机降级承担），桌面 VM 无状态。
6. 桌面**首次连接时懒创建**，长期绑定；空闲 7 天挂起、30 天销毁（数据不丢）。
7. RDP 认证采用**每 VM 随机强密码 + Guacamole 自动登录**（方案 B），并接受 guac 库明文存储的既有风险（配合库隔离加固）。
8. 不引入 Redis/消息队列，任务队列用 PostgreSQL `SKIP LOCKED`。
9. 已有阿里云 Linux 服务器继续承载 Guacamole + PostgreSQL + DMS，与 Proxmox 内网通过隧道打通。
10. Windows / RDS CAL / 统计软件授权**已具备多实例合规条件**（Q2/Q3 需最终确认，否则本章成本与选型结论需重算）。


