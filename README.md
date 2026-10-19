# 统计软件托管平台

在不修改无源码 Windows 桌面软件的前提下，让用户通过浏览器使用 Windows 分析主机上的桌面软件，并提供数据隔离、原始数据保护和结果审查功能。

## 核心特性

- **软件全开放**：所有登录用户均可使用该主机上安装的全部桌面软件，无软件级权限限制
- **数据权限隔离**：用户之间的唯一区别是数据权限，每人只能访问自己部门/项目范围内的数据
- **浏览器远程使用**：通过 Apache Guacamole + RDS，用户在浏览器中即可操作桌面软件
- **原始数据保护**：禁用剪贴板、本地驱动器映射、打印重定向，防止数据泄露
- **结果审查导出**：分析结果经白名单/敏感字段/行数/聚合检查后才能下载
- **多用户并行**：每用户独立 RDS 会话 + 独立工作区（W: 盘），互不干扰

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端门户 | Web（登录 / 软件列表 / 我的结果 / 审计日志） |
| 后端 API | Python FastAPI |
| 远程桌面 | Windows Server 2022 + RDS + Apache Guacamole |
| 数据库 | PostgreSQL |
| 桌面软件 | 不限具体软件；清单由 Windows 端 `software-registry.json` 维护 |

## 项目结构

```
stats-platform/
├── app/                        # FastAPI 后端
│   ├── __init__.py
│   ├── config.py               # 平台配置（数据库、JWT、路径等）
│   ├── database.py             # SQLAlchemy 连接与会话管理
│   ├── models.py               # ORM 模型（users/scopes/sessions/...）
│   ├── schemas.py              # Pydantic 请求/响应 Schema
│   ├── auth.py                 # JWT 认证与权限校验
│   ├── review.py               # 结果审查服务（白名单/敏感字段/行数检查）
│   ├── main.py                 # FastAPI 入口
│   └── routers/                # 路由模块
│       ├── __init__.py
│       ├── auth.py             # POST /auth/login, GET /me
│       ├── session.py          # POST /session/connect
│       ├── results.py           # GET /results/mine, POST /results/scan, POST /results/{id}/download
│       └── admin.py            # GET /admin/audit, GET /admin/pending
├── guacamole/                  # Guacamole 部署配置
│   ├── docker-compose.yml      # guacd + postgres + guacamole 三容器编排
│   ├── nginx-guacamole.conf    # Nginx 反向代理 + WebSocket + HTTPS
│   └── .env.example            # 数据库密码环境变量模板
├── powershell/                 # Windows 脚本
│   ├── setup-rdsh.ps1          # RDS 会话主机部署脚本（装角色/配许可/建本地用户，无域环境）
│   ├── login.ps1               # 用户登录脚本（映射 Z:/W: 盘、环境变量、按注册表建快捷方式、落点强制）
│   ├── software-registry.json  # 桌面软件注册表（桌面快捷方式清单，运维手工维护并部署）
│   ├── enforce-output-location.ps1 # 机器级落点强制（通用对话框位置栏，新装软件后重跑）
│   └── configure-rds.ps1       # RDS 安全配置（禁用剪贴板/驱动器/打印）
├── schema.sql                  # PostgreSQL 数据库 DDL
└── requirements.txt            # Python 依赖
```

## API 端点

| 方法 | 路径 | 说明 | 权限 |
|------|------|------|------|
| POST | `/auth/register` | 用户注册（角色固定为 user，无数据权限） | 公开 |
| POST | `/auth/login` | 登录获取 JWT Token | 公开 |
| GET | `/auth/me` | 获取当前用户信息与数据范围 | 登录 |
| POST | `/session/connect` | 连接 Windows 分析平台（单按钮） | 登录 |
| POST | `/data/import` | 导入数据集 CSV 到数据库 | 管理员 |
| POST | `/data/fetch` | 获取数据（读库生成 Excel 到文件服务器） | 登录 |
| GET | `/results/mine` | 获取我的导出申请和已发布结果 | 登录 |
| POST | `/results/request-export` | 申请导出结果（待管理员审核） | 登录 |
| POST | `/results/{id}/download` | 下载已通过审核的结果文件 | 登录 |
| GET | `/admin/audit` | 查看审计日志 | 管理员 |
| GET | `/admin/pending` | 查看待审核的导出申请 | 管理员 |
| POST | `/admin/pending/{id}/approve` | 审核通过导出申请 | 管理员 |
| POST | `/admin/pending/{id}/reject` | 审核拒绝导出申请 | 管理员 |
| GET | `/admin/users` | 查看所有用户及其数据权限 | 管理员 |
| GET | `/admin/scopes` | 查看所有数据范围（部门/项目） | 管理员 |
| PUT | `/admin/users/{id}/scopes` | 分配用户数据权限（部门+项目范围） | 管理员 |

## 数据库表

| 表名 | 说明 |
|------|------|
| `users` | 用户表（username, ad_sid, dept_id, role） |
| `scopes` | 部门/项目范围（scope_code, scope_type, data_path） |
| `user_scope` | 用户-范围关联（多对多） |
| `sessions` | 远程会话记录（guac_identifier, status） |
| `pending_files` | 导出申请（file_path, status, review_reason） |
| `export_results` | 已发布结果（result_name, file_path, download_count） |
| `audit_logs` | 审计日志（action, detail, ip_addr） |
| `dataset_meta` | 数据集元数据（列名 JSON、总行数） |
| `dataset_rows` | 数据集行数据（每行 JSON 字典） |

## 目录结构规范

```
\\fileserver\
  data\{scope}\              ← 原始数据（只读，按部门/项目隔离）
  workspace\{user_id}\       ← 用户工作区（可写）
  pending\{user_id}\         ← 待审查结果
  published\{result_id}\     ← 已发布结果
  scripts\                    ← 登录脚本
```

## 安全机制

| 安全要求 | 实现方式 |
|---------|---------|
| 软件权限 | 所有登录用户可用全部软件，无软件级权限区分 |
| 数据权限 | 用户唯一区别，由管理员通过 `/admin/users/{id}/scopes` 分配部门/项目范围 |
| 原始数据只读 | Z: 盘通过 ACL 设置 ReadAndExecute 权限 |
| 无本地拷贝 | RDS 禁用本地驱动器映射 + 剪贴板重定向 + 打印重定向 |
| 数据隔离 | 每用户只映射自己 dept/project 的 Z: 盘 |
| 结果导出审核 | 所有文件类型均可申请导出；系统与原始数据集做相似度比对，≥60% 转管理员人工审核，低于 60% 免审自动发布 |
| 多用户并行 | RDS 每用户独立 Session + 独立 W: 盘工作区 |
| 审计追踪 | `audit_logs` 表记录登录/连接/申请/审核/下载全链路 |

## 数据获取与导出流程

**1. 数据获取**：管理员 `POST /data/import` 把 `testData.csv`（GBK 编码，612 列 × 1074 行医学队列数据）解析入库（`dataset_meta` + `dataset_rows`）。用户点「获取数据」→ `POST /data/fetch` 从数据库读全量数据，用 openpyxl 生成 `testData_YYYYMMDD_HHmmss.xlsx`（同秒重复获取追加 `_2` 序号，历史文件保留不覆盖）存到 `fileserver_root/data/`，并 SFTP 推送到 Windows 云主机 Z: 盘，供用户在 Windows 平台分析使用。

**2. 导出审核**：普通用户不能直接导出 Windows 平台内的任何数据。用户点「申请导出结果」→ `POST /results/request-export` 经 SFTP 回拉其 pending 目录中的结果文件（**所有文件类型均可**），系统逐个与原始数据集 `testData.csv` 做相似度比对：相似度 **≥ 60%**（环境变量 `EXPORT_REVIEW_SIMILARITY_THRESHOLD` 可调）登记为待审核，管理员在「待审核导出申请」中人工 `approve` / `reject`；相似度 **低于 60%**、或图片/PDF/二进制等无法提取文本的文件，**免审核自动发布**，立即出现在「已发布」列表可下载（30 天有效）；原始基线文件缺失无法判定时安全默认转人工审核。

## 结果审查规则（相似度自动比对）

系统在用户申请导出时，对待导出文件与原始数据集 `testData.csv` 做相似度比对，作为是否需要人工审核的依据：

- **全类型可导出**：不再做扩展名白名单拦截，所有文件类型都允许申请
- **可提取文本的文件**（`.csv` `.txt` `.out` `.log` `.tsv` `.xlsx` 等）：相似度取两个指标的较大值
  - 行命中率：候选文件的行在原始数据集中逐行出现的比例（直接复制/切片原始数据时命中高）
  - token 覆盖率：候选内容的字段/数值 token 在原始数据集中的占比（换分隔符等格式变化仍敏感）
  - 表头行不计入命中，避免单个表头推高小文件的相似度
- **阈值判定**：相似度 ≥ 60% 判定疑似原始数据，转管理员人工审核；< 60% 免审核自动发布
- **图片/PDF/二进制文件**：无法提取文本、不参与比对，免审核自动发布
- **基线缺失**：服务器上 `testData.csv` 缺失无法判定时，安全默认转人工审核
- **编码兼容**：基线与候选文件均支持 UTF-8 / GBK 解码（生产原始数据为 GBK）
- **旧规则保留**：`review.py` 中原字段白名单 / 敏感正则 / 行列数上限等规则函数仍保留，可供管理员人工审核参考或后续扩展

阈值与免审发布有效期可通过环境变量 `EXPORT_REVIEW_SIMILARITY_THRESHOLD`（默认 0.6）、`EXPORT_PUBLISH_VALID_DAYS`（默认 30）配置。

## 快速开始

### 1. Linux Server（后端 + Guacamole）

```bash
# 安装 PostgreSQL 并导入 DDL
# 注意：下面的数据库密码 'stats123' 仅为示例，请替换为强密码并同步到 .env 的 DATABASE_URL


sudo -u postgres psql -c "CREATE USER stats WITH PASSWORD 'stats123';"
sudo -u postgres psql -c "GRANT ALL ON DATABASE stats_platform TO stats;"
psql -U stats -d stats_platform -f schema.sql

# 部署 FastAPI
cd stats-platform
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt

# 配置环境变量
cp .env.example .env  # 修改数据库连接、JWT 密钥等

# 启动
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

### 2. Windows Server 2022（RDS 会话主机 + 桌面软件）

> **部署模式：单机 + 无域 + IP 访问**
> 本架构仅需 Remote Desktop Session Host 角色，通过 Guacamole → RDP → 服务器 IP 直连，**不需要** Active Directory 域、Connection Broker 或 RDS 部署。

```powershell
# ① 一键部署会话主机（安装角色 + 配置许可 + 创建本地用户）
#    以管理员身份运行 PowerShell
Set-ExecutionPolicy Bypass -Scope Process -Force

# 方式A：批量创建用户（users.csv 含 username,password 两列）
.\powershell\setup-rdsh.ps1 -UserCsv .\users.csv

# 方式B：创建单个用户（密码运行时提示）
.\powershell\setup-rdsh.ps1 -NewUser "user1"

# 方式C：仅装角色和配置许可（不建用户）
.\powershell\setup-rdsh.ps1

# 若提示需要重启，重启后重新运行脚本即可（脚本会检测已安装项自动跳过）

# ② 运行安全配置（禁用剪贴板/驱动器/打印）
.\powershell\configure-rds.ps1
Restart-Service -Name TermService -Force

# ③ 安装所需桌面软件到 C:\Program Files（或任意固定路径），
#     再把每个软件的启动信息登记到 powershell\software-registry.json，
#     登录脚本据此为每位用户生成桌面快捷方式。
#   示例（按实际安装路径填写）：
#     [
#       { "key": "spss", "name": "SPSS",  "path": "C:\\Program Files\\IBM\\SPSS\\Statistics\\client\\stats.exe", "args": "" },
#       { "key": "r",   "name": "R",     "path": "C:\\Program Files\\R\\R-4.3.2\\bin\\Rgui.exe",                "args": "" }
#     ]

# ③.5 软件安装后运行一次：锁定通用"另存为"位置栏、加固 C: 根 ACL
#      （新装/升级任何桌面软件后重跑一次即可，幂等）
.\powershell\enforce-output-location.ps1

# ④ 部署登录脚本（单机一体部署：放本机固定目录 + 公共启动项）
$scriptsDir = "C:\stats-scripts"
New-Item -ItemType Directory -Path $scriptsDir -Force | Out-Null
Copy-Item .\powershell\login.ps1 "$scriptsDir\login.ps1" -Force
# 登录脚本同目录需放置软件注册表（运维手工维护，JSON 数组，UTF-8 无 BOM）
Copy-Item .\powershell\software-registry.json "$scriptsDir\software-registry.json" -Force
# 普通用户只读、不可篡改脚本；SYSTEM/Administrators 完全控制
icacls $scriptsDir /inheritance:r /grant "*S-1-5-32-545:(OI)(CI)(RX)" "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" | Out-Null
# 所有用户登录时以本人身份执行（与 map-z/map-w-drive.cmd 同一启动目录）
$startup = "C:\ProgramData\Microsoft\Windows\Start Menu\Programs\StartUp"
$wrapper = Join-Path $startup "run-login.cmd"
"@echo off`r`npowershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$scriptsDir\login.ps1`"" |
    Set-Content $wrapper -Encoding ASCII

# 多机部署（独立文件服务器）时，才改用共享路径（注册表同目录一并复制）：
# Copy-Item .\powershell\login.ps1 \\fileserver\scripts\login.ps1
# Copy-Item .\powershell\software-registry.json \\fileserver\scripts\software-registry.json
```

> 登录脚本 / 注册表更新流程（本次 login.ps1 或 software-registry.json 修改后必做）：在仓库目录 `git pull`
> 后重新执行上面第 ④ 步的 `Copy-Item ... C:\stats-scripts\login.ps1`（若改了注册表，同时复制
> `software-registry.json`），已登录用户**注销重新登录**一次生效。

**生成物落点强制（保证各软件生成文件都在本人指定目录）：**

| 层级 | 措施 | 生效范围 |
|------|------|---------|
| 会话 | RDS 每用户独立 Session，剪贴板/本地盘/打印重定向禁用 | 所有软件 |
| 目录 | `C:\workspace\{用户}`（W:）/ `C:\pending\{用户}` NTFS 仅本人可写 + SMB 开启 ABE | 所有软件 |
| 重定向 | 登录时把**桌面/文档/下载**重定向到 `W:\Desktop` 等子目录（首次自动迁移存量文件），存到这些常见位置实际都进本人 W: 盘 | 所有软件 |
| 隐藏盘符 | 普通用户资源管理器/标准"另存为"对话框隐藏并禁止访问 C:（管理员豁免；不影响软件运行，W:/Z: 网络盘不受限） | 所有软件 |
| 位置栏 | 打开/另存为对话框左侧栏固定为 W: / 本人待导出目录 / Z: | 所有标准文件对话框 |
| 启动目录 | 桌面快捷方式起始目录固定为 W:（按 `software-registry.json` 生成），软件打开即落在本人工作区 | 所有经桌面快捷方式启动的软件 |
| 唯一出口 | 后端只回拉 `C:\pending\{用户}` 申请导出，落在其他位置的文件无导出渠道 | 平台规则 |

> 通用 GUI 软件的"另存为"无法在应用层拦截，业界通行做法即"唯一可写位置 + 隐藏其他位置 + 出口管控"组合。`%TEMP%`/AppData 保持可写以确保软件正常运行；可选 `enforce-output-location.ps1 -HardenRootAcl` 进一步禁止普通用户在 `C:\` 根新建文件。
>
> **后续新软件接入清单**（无需改后端）：① 正常安装到 `C:\Program Files`（或任意固定路径）；② 在 `powershell\software-registry.json` 追加一条登记项（起始目录自动为 W:）；③ 把注册表重新复制到 `C:\stats-scripts\`；④ 若该软件有专有的启动配置机制，参照 `enforce-output-location.ps1` 结构另行扩展并重跑一次。其余重定向/隐藏/位置栏/出口管控对它自动生效。

#### 软件注册表（`powershell/software-registry.json`）

桌面软件清单的唯一来源，由**运维手工维护**并把文件复制到登录脚本同目录（默认 `C:\stats-scripts\`），平台侧不建表、不提供管理界面、不下发该文件。

| 字段 | 类型 | 说明 |
|------|------|------|
| `key` | string | 软件唯一标识（小写），供 `login.ps1 -Software <key>` 按名启动 |
| `name` | string | 桌面快捷方式显示名（如 `SPSS`、`R`） |
| `path` | string | 可执行文件绝对路径（JSON 中反斜杠需转义为 `\\`） |
| `args` | string | 启动参数，无则填空字符串 `""` |

- **文件位置**：与 `login.ps1` 同目录（`$PSScriptRoot\software-registry.json`）
- **初始内容**：空数组 `[]`（表示暂无登记软件，登录脚本跳过快捷方式创建并输出告警）
- **维护方式**：直接编辑仓库内的 `powershell/software-registry.json`，再按第 ④ 步复制到主机；登录脚本对缺失/解析失败做容错（仅告警，不中断登录）
- **编码**：UTF-8 **无 BOM**（与带 BOM 的 `.ps1` 不同），登录脚本以 `Get-Content -Raw -Encoding UTF8` 读取

**重要说明（无域环境）：**

| 项目 | 说明 |
|------|------|
| 不装 Connection Broker | `New-RDSessionDeployment` / `Set-RDLicenseConfiguration` 依赖 AD 域，无域环境必然失败，请勿使用 |
| 登录账户 | Guacamole 登录的是服务器**本地账户**（由 `setup-rdsh.ps1` 创建），非域账户 |
| 许可宽限期 | 未配置许可服务器时，有 120 天宽限期；生产环境需购买 RDS CAL |
| 公网域名 | 购买的域名（如 `chunjindevelop68.xyz`）用于给 Guacamole/Web 门户做正式访问入口，与 AD 域无关 |

### 3. Guacamole（Linux 服务器 + Docker）

架构：浏览器 → Guacamole(Web) → guacd(RDP 后端) → Windows 云主机 `8.133.223.251`

> 以下命令以 **Alibaba Cloud Linux 3**（dnf 包管理器）为例。

```bash
# ① 安装 Docker 与 Docker Compose（使用阿里云镜像源）
sudo dnf install -y dnf-utils device-mapper-persistent-data lvm2

# 手动创建 docker-ce 源，将 $releasever 写死为 8
# （Alibaba Cloud Linux 3 的 $releasever 可能被错误解析为 4，导致 404）
sudo rm -f /etc/yum.repos.d/docker-ce.repo
sudo tee /etc/yum.repos.d/docker-ce.repo > /dev/null <<'EOF'
[docker-ce-stable]
name=Docker CE Stable - $basearch
baseurl=https://mirrors.aliyun.com/docker-ce/linux/centos/8/$basearch/stable
enabled=1
gpgcheck=1
gpgkey=https://mirrors.aliyun.com/docker-ce/linux/centos/gpg
EOF

sudo dnf makecache
sudo dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo systemctl enable --now docker

# ①b 配置镜像加速器（国内无法直连 Docker Hub，必须配置，否则拉取镜像超时）
# 说明：阿里云个人版镜像加速器已停用，改用 DaoCloud 公开加速器
sudo mkdir -p /etc/docker
sudo tee /etc/docker/daemon.json > /dev/null <<'EOF'
{
  "registry-mirrors": [
    "https://docker.m.daocloud.io"
  ]
}
EOF
sudo systemctl daemon-reload
sudo systemctl restart docker

# 备选：若 DaoCloud 加速器不稳定，可用代理站前缀直接拉取镜像
# sudo docker pull docker.m.daocloud.io/guacamole/guacd:1.5.5
# sudo docker pull docker.m.daocloud.io/guacamole/guacamole:1.5.5
# sudo docker tag docker.m.daocloud.io/guacamole/guacd:1.5.5 guacamole/guacd:1.5.5
# sudo docker tag docker.m.daocloud.io/guacamole/guacamole:1.5.5 guacamole/guacamole:1.5.5

# ② 将 guacamole 目录上传到服务器，进入该目录
cd guacamole

# ③ 生成数据库初始化脚本 initdb.sql（PostgreSQL JDBC 认证 schema）
#    注意：Guacamole 官方 Docker 镜像不支持 user-mapping.xml 文件认证，
#          必须使用数据库（JDBC）/ LDAP / RADIUS 认证，这里用 PostgreSQL。
docker run --rm guacamole/guacamole:1.5.5 /opt/guacamole/bin/initdb.sh --postgresql > initdb.sql

# ④ 配置数据库密码（环境变量，不入库）
cp .env.example .env
vim .env   # 填入 POSTGRES_PASSWORD

# ⑤ 启动（首次启动会自动执行 initdb.sql 初始化数据库）
sudo docker compose up -d

# ⑥ 验证
sudo docker compose ps          # 三个容器应为 running（guacd/postgres/guacamole）
sudo docker compose logs guacamole   # 查看日志无报错
```

**首次登录**：`http://<Linux服务器IP>:8080/guacamole/`，默认管理员 `guacadmin` / `guacadmin`（登录后请立即修改密码）。

**创建用户与 RDP 连接**（登录后在 Web UI 操作）：
1. 「设置 → 用户」新建用户（如 `user1`）
2. 「设置 → 连接」新建连接：协议选 `RDP`，主机填 `8.133.223.251`，端口 `3389`，填 Windows 本地账户密码
3. 在「连接 → 用户」页给用户分配可用的连接

**RDP 连接安全参数**（在连接编辑页的「参数」区手动添加，实现原始数据保护）：

| 参数名 | 值 | 作用 |
|--------|-----|------|
| `security` | `tls` | 使用 TLS 安全层（配合 Windows 关闭 NLA） |
| `ignore-cert` | `true` | 忽略自签名证书 |
| `disable-copy` | `true` | 禁用剪贴板复制 |
| `disable-paste` | `true` | 禁用剪贴板粘贴 |
| `disable-drive` | `true` | 禁用本地驱动器映射 |
| `disable-printing` | `true` | 禁用打印重定向 |

> ⚠️ **不要填任何 `gateway-*` 参数**（远程桌面网关配置）。直连 Windows 主机场景下若误填 `gateway-hostname` 等参数，Guacamole 会误判为走 RD 网关，导致 `Security negotiation failed (wrong security type?)`。

### RDP 连接排错（Windows Server 2022 必读）

Windows Server 2012+ 已废弃标准 RDP 加密（RC4），实际强制走 TLS；同时 Guacamole 1.5.5 内置 FreeRDP 与 Server 2022 存在兼容性问题（GUACAMOLE-1920）。因此**必须使用 1.6.0 及以上版本**，并按以下组合配置：

**1. Windows 端关闭 NLA、强制 TLS**（管理员 PowerShell）：

```powershell
$p = "HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp"
Set-ItemProperty -Path $p -Name "UserAuthentication" -Value 0 -Type DWord   # 0 = 关 NLA
Set-ItemProperty -Path $p -Name "SecurityLayer"    -Value 1 -Type DWord   # 1 = 强制 TLS
Restart-Service TermService -Force
```

**2. Guacamole 连接参数**：`security=tls` + `ignore-cert=true`，且**不填 gateway-\* 参数**。

**常见报错对照**：

| 报错 | 原因 | 解决 |
|------|------|------|
| `Authentication failure (invalid credentials?)` | Windows 账号名或密码错误 | 用 `mstsc` 验证凭据；`Get-LocalUser` 确认账户名 |
| `Security negotiation failed (wrong security type?)` | 误填 `gateway-*` 参数，或安全模式与 Windows 不一致 | 删除 `gateway-*`；统一 `security=tls` + 关 NLA |
| `SSL/TLS connection failed (untrusted/self-signed certificate?)` | 证书不被信任，或 `SecurityLayer=0` 被 Server 2022 忽略 | 勾选/写入 `ignore-cert=true`；`SecurityLayer` 设为 `1` |

**配置 HTTPS（域名 chunjindevelop68.xyz）**：用 Nginx 反向代理 8080 端口（已提供 `guacamole/nginx-guacamole.conf`）。步骤：

```bash
# ① 安装 Nginx + certbot
sudo dnf install -y nginx
sudo dnf install -y python3-pip
sudo pip3 install certbot

# ② 停掉 nginx，确保 80 端口空闲（standalone 方式需要占用 80 验证）
sudo systemctl stop nginx 2>/dev/null || true

# ③ 先用 standalone 方式申请证书（只生成证书，不改 nginx）
#    需确保域名 guac.chunjindevelop68.xyz 已解析到本机公网 IP
sudo certbot certonly --standalone -d guac.chunjindevelop68.xyz \
    --agree-tos --non-interactive -m your-email@example.com

# ④ 复制配置文件（此时证书已存在，443 配置可正常加载）
sudo cp guacamole/nginx-guacamole.conf /etc/nginx/conf.d/guacamole.conf

# ⑤ 测试并启动 Nginx
sudo nginx -t
sudo systemctl enable --now nginx
```

> 说明：`nginx-guacamole.conf` 已内置完整的 443 HTTPS server 和证书路径（`/etc/letsencrypt/live/...`），所以必须**先申请证书、再复制配置**，否则 nginx 会因引用不存在的证书而无法启动。不要用 `certbot --nginx`（它会和已写好的 443 配置冲突）。

完成后通过 `https://guac.chunjindevelop68.xyz/guacamole/` 访问。

> 注意：
> - nginx 配置中 WebSocket 升级（`Upgrade`/`Connection`）是关键，Guacamole 远程桌面画面依赖它，请勿删除。
> - 若 `pip3 install certbot` 安装的 `certbot` 命令不在 PATH，可用 `python3 -m certbot` 替代。
> - 阿里云安全组需放行 80 / 443 端口（8080 端口仅在未收紧时用，建议收紧为仅本机访问）。
> - 证书续期：`sudo certbot renew --quiet` 可加入 crontab 自动续期。

## 环境配置

隐私配置（数据库连接串、JWT 密钥）**不设默认值**，必须通过环境变量或 `.env` 文件提供，缺失时启动会立即报错。

**快速开始：**

```bash
# 1. 复制模板并填入真实值
cp .env.example .env
# 编辑 .env，至少修改 DATABASE_URL 和 JWT_SECRET 两个必填项

# 2. 启动（uvicorn 会自动加载 .env）
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

**完整配置项：**

| 配置项 | 默认值 | 是否必填 | 说明 |
|--------|--------|:---:|------|
| `DATABASE_URL` | 无 | ✅ 必填 | 数据库连接串（含密码） |
| `JWT_SECRET` | 无 | ✅ 必填 | JWT 签名密钥（建议 `python -c "import secrets; print(secrets.token_hex(32))"` 生成） |
| `JWT_ALGORITHM` | `HS256` | 否 | JWT 算法 |
| `JWT_EXPIRE_HOURS` | `8` | 否 | Token 有效期（小时） |
| `FILESERVER_ROOT` | `\\fileserver` | 否 | 文件服务器根路径 |
| `RDS_HOST` | `8.133.223.251` | 否 | RDS 服务器地址（Windows 云主机 IP） |
| `RDS_PORT` | `3389` | 否 | RDP 端口 |
| `GUACAMOLE_URL` | `https://guac.chunjindevelop68.xyz/guacamole/#/client/` | 否 | Guacamole 前端地址 |

> 环境变量名与 `config.py` 中字段名一一对应（大小写不敏感）。`.env` 已被 `.gitignore` 排除，不会提交到 git。
>
> 桌面软件清单不在环境变量中配置：统一由 Windows 端登录脚本同目录的 `software-registry.json` 维护（见上文「软件注册表」）。

## 演示账号

演示账号密码通过环境变量配置（见上表 `DEMO_ADMIN_PASSWORD` / `DEMO_USER_PASSWORD`）：

| 用户名 | 角色 | 密码来源 |
|--------|------|---------|
| `admin` | 管理员 | 环境变量 `DEMO_ADMIN_PASSWORD` |
| `user1` | 普通用户 | 环境变量 `DEMO_USER_PASSWORD` |

> **注意**：
> - 环境变量留空则对应演示账号**禁用登录**（不创建、无法验证）。
> - 生产环境建议不启用演示账号，改用 `/auth/register` 注册账号，并由管理员分配数据权限。
> - 如需启用，在 `.env` 中设置 `DEMO_ADMIN_PASSWORD=你的密码`、`DEMO_USER_PASSWORD=你的密码`。

## 工作流程

```
用户登录 → 获取 JWT → 请求 /session/connect
                              ↓
              后端调 PowerShell 创建 RDS 会话
                              ↓
              返回 Guacamole URL → 浏览器打开远程桌面
                              ↓
              Z: 盘读取原始数据（只读）→ W: 盘工作区分析
                              ↓
              结果保存到 \\fileserver\pending\{user_id}\
                              ↓
              请求 /results/scan → 审查服务自动检查
                              ↓
              审查通过 → 复制到 published 目录 → 写入 export_results
              审查失败 → 标记 rejected + 审计日志
                              ↓
              GET /results/mine → POST /results/{id}/download
```
