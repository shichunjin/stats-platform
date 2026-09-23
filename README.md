# 统计软件托管平台

在不修改无源码 Windows 桌面软件的前提下，让用户通过浏览器使用 RStudio、Mplus Editor、StataSE 18 等统计软件，并提供数据隔离、原始数据保护和结果审查功能。

## 核心特性

- **软件全开放**：所有登录用户均可使用全部统计软件，无软件级权限限制
- **数据权限隔离**：用户之间的唯一区别是数据权限，每人只能访问自己部门/项目范围内的数据
- **浏览器远程使用**：通过 Apache Guacamole + RDS，用户在浏览器中即可操作统计软件
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
| 统计软件 | RStudio Desktop / Mplus + Mplus Editor / StataSE 18 |

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
│       ├── session.py          # POST /session/launch/{software}
│       ├── results.py           # GET /results/mine, POST /results/scan, POST /results/{id}/download
│       └── admin.py            # GET /admin/audit, GET /admin/pending
├── guacamole/                  # Guacamole 部署配置
│   ├── docker-compose.yml      # guacd + postgres + guacamole 三容器编排
│   ├── nginx-guacamole.conf    # Nginx 反向代理 + WebSocket + HTTPS
│   └── .env.example            # 数据库密码环境变量模板
├── powershell/                 # Windows 脚本
│   ├── setup-rdsh.ps1          # RDS 会话主机部署脚本（装角色/配许可/建本地用户，无域环境）
│   ├── login.ps1               # 用户登录脚本（映射 Z:/W: 盘、环境变量、快捷方式）
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
| POST | `/session/launch/{software}` | 启动远程会话（software=rstudo\|mplus\|stata） | 登录 |
| GET | `/results/mine` | 获取我的待审查文件和已发布结果 | 登录 |
| POST | `/results/scan` | 扫描 pending 目录并自动审查 | 登录 |
| POST | `/results/{id}/download` | 下载已发布的结果文件 | 登录 |
| GET | `/admin/audit` | 查看审计日志 | 管理员 |
| GET | `/admin/pending` | 查看所有待审查文件 | 管理员 |
| GET | `/admin/users` | 查看所有用户及其数据权限 | 管理员 |
| GET | `/admin/scopes` | 查看所有数据范围（部门/项目） | 管理员 |
| PUT | `/admin/users/{id}/scopes` | 分配用户数据权限（部门+项目范围） | 管理员 |

## 数据库表

| 表名 | 说明 |
|------|------|
| `users` | 用户表（username, ad_sid, dept_id, role） |
| `scopes` | 部门/项目范围（scope_code, scope_type, data_path） |
| `user_scope` | 用户-范围关联（多对多） |
| `sessions` | 远程会话记录（software, guac_identifier, status） |
| `pending_files` | 待审查文件（file_path, status, review_reason） |
| `export_results` | 已发布结果（result_name, file_path, download_count） |
| `audit_logs` | 审计日志（action, detail, ip_addr） |

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
| 结果审查 | `review.py` 做白名单/敏感字段/行数/聚合检查 |
| 多用户并行 | RDS 每用户独立 Session + 独立 W: 盘工作区 |
| 审计追踪 | `audit_logs` 表记录登录/启动/审查/下载全链路 |

## 结果审查规则

- **文件类型白名单**：仅允许 `.csv` `.png` `.jpg` `.out` `.txt` `.log` `.pdf`
- **CSV 字段白名单**：只允许聚合结果列名（mean, std, coef, p_value, rmsea, cfi 等）
- **敏感字段名拦截**：id, name, phone, id_card, address, email 等列名直接拒绝
- **敏感数据正则**：身份证号、手机号、邮箱、姓名（先生/女士/同志）
- **行数上限**：CSV 最多 200 行，超过判定为原始明细数据
- **列数上限**：CSV 最多 30 列，超过判定为原始宽表
- **文本文件检查**：.out/.log 文件中检测敏感数据和大量连续数字行

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

### 2. Windows Server 2022（RDS 会话主机 + 统计软件）

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

# ③ 安装统计软件
# RStudio Desktop → C:\Program Files\RStudio\bin\rstudio.exe
# Mplus           → C:\Program Files\Mplus\mplus.exe
# Stata SE 18     → C:\Program Files\Stata18\StataSE-64.exe

# ④ 部署登录脚本到文件服务器
Copy-Item .\powershell\login.ps1 \\fileserver\scripts\login.ps1
```

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
| `security` | `nla` | 网络级认证 |
| `ignore-cert` | `true` | 忽略证书 |
| `disable-copy` | `true` | 禁用剪贴板复制 |
| `disable-paste` | `true` | 禁用剪贴板粘贴 |
| `disable-drive` | `true` | 禁用本地驱动器映射 |
| `disable-printing` | `true` | 禁用打印重定向 |

**配置 HTTPS（域名 chunjindevelop68.xyz）**：用 Nginx 反向代理 8080 端口（已提供 `guacamole/nginx-guacamole.conf`）。步骤：

```bash
# ① 安装 Nginx + certbot
sudo dnf install -y nginx
sudo dnf install -y python3-pip
sudo pip3 install certbot certbot-nginx

# ② 复制配置文件
sudo cp nginx-guacamole.conf /etc/nginx/conf.d/guacamole.conf

# ③ 申请 SSL 证书（自动修改配置）
sudo certbot --nginx -d guac.chunjindevelop68.xyz

# ④ 启动并重载 Nginx
sudo systemctl enable --now nginx
sudo nginx -t && sudo systemctl reload nginx
```

完成后通过 `https://guac.chunjindevelop68.xyz/guacamole/` 访问。

> 注意：
> - nginx 配置中 WebSocket 升级（`Upgrade`/`Connection`）是关键，Guacamole 远程桌面画面依赖它，请勿删除。
> - 若 `pip3 install certbot` 安装的 `certbot` 命令不在 PATH，可用 `python3 -m certbot` 替代。
> - 阿里云安全组需放行 80 / 443 / 8080 端口。

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
| `GUACAMOLE_URL` | `https://guac.chunjindevelop68.xyz/#/client/` | 否 | Guacamole 前端地址 |
| `RSTUDIO_PATH` | `C:\Program Files\RStudio\bin\rstudio.exe` | 否 | RStudio 安装路径 |
| `MPLUS_PATH` | `C:\Program Files\Mplus\mplus.exe` | 否 | Mplus 安装路径 |
| `STATA_PATH` | `C:\Program Files\Stata18\StataSE-64.exe` | 否 | Stata 安装路径 |

> 环境变量名与 `config.py` 中字段名一一对应（大小写不敏感）。`.env` 已被 `.gitignore` 排除，不会提交到 git。

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
用户登录 → 获取 JWT → 请求 /session/launch/rstudio
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
