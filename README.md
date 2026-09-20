# 统计软件托管平台

在不修改无源码 Windows 桌面软件的前提下，让用户通过浏览器使用 RStudio、Mplus Editor、StataSE 18 等统计软件，并提供数据隔离、原始数据保护和结果审查功能。

## 核心特性

- **浏览器远程使用**：通过 Apache Guacamole + RDS，用户在浏览器中即可操作统计软件
- **数据权限隔离**：每个用户只能访问自己部门/项目范围内的数据（Z: 盘只读）
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
├── guacamole/                  # Guacamole 配置
│   ├── guacd-config.properties # Guacamole 属性配置
│   └── user-mapping.xml        # 用户-连接映射（禁用剪贴板/驱动器）
├── powershell/                 # Windows 脚本
│   ├── login.ps1               # 用户登录脚本（映射 Z:/W: 盘、环境变量、快捷方式）
│   └── configure-rds.ps1       # RDS 安全配置（禁用剪贴板/驱动器/打印）
├── schema.sql                  # PostgreSQL 数据库 DDL
└── requirements.txt            # Python 依赖
```

## API 端点

| 方法 | 路径 | 说明 | 权限 |
|------|------|------|------|
| POST | `/auth/login` | 登录获取 JWT Token | 公开 |
| GET | `/me` | 获取当前用户信息与数据范围 | 登录 |
| POST | `/session/launch/{software}` | 启动远程会话（software=rstudo\|mplus\|stata） | 登录 |
| GET | `/results/mine` | 获取我的待审查文件和已发布结果 | 登录 |
| POST | `/results/scan` | 扫描 pending 目录并自动审查 | 登录 |
| POST | `/results/{id}/download` | 下载已发布的结果文件 | 登录 |
| GET | `/admin/audit` | 查看审计日志 | 管理员 |
| GET | `/admin/pending` | 查看所有待审查文件 | 管理员 |

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
sudo -u postgres psql -c "CREATE DATABASE stats_platform;"
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

### 2. Windows Server 2022（RDS + 统计软件）

```powershell
# 安装 RDS 角色
Install-WindowsFeature RDS-RD-Server -IncludeManagementTools

# 运行安全配置（禁用剪贴板/驱动器/打印）
Set-ExecutionPolicy Bypass -Scope Process -Force
.\powershell\configure-rds.ps1
Restart-Service -Name TermService -Force

# 安装统计软件
# RStudio Desktop → C:\Program Files\RStudio\bin\rstudio.exe
# Mplus           → C:\Program Files\Mplus\mplus.exe
# Stata SE 18     → C:\Program Files\Stata18\StataSE-64.exe

# 部署登录脚本到文件服务器
Copy-Item .\powershell\login.ps1 \\fileserver\scripts\login.ps1

# 通过组策略或 RDS 会话启动脚本配置 login.ps1 为用户登录脚本
```

### 3. Guacamole

```bash
# 安装 guacd 和 Guacamole Client（参考官方文档）
# 部署配置文件
sudo cp guacamole/guacd-config.properties /etc/guacamole/guacamole.properties
sudo cp guacamole/user-mapping.xml /etc/guacamole/user-mapping.xml
sudo systemctl restart guacd tomcat9
```

## 环境配置

在 `app/config.py` 中或通过 `.env` 文件配置：

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `DATABASE_URL` | `postgresql+psycopg2://stats:stats123@localhost:5432/stats_platform` | 数据库连接 |
| `JWT_SECRET` | `change-me-in-production...` | JWT 签名密钥 |
| `JWT_EXPIRE_HOURS` | `8` | Token 有效期（小时） |
| `FILESERVER_ROOT` | `\\fileserver` | 文件服务器根路径 |
| `RDS_HOST` | `10.0.1.100` | RDS 服务器地址 |
| `GUACAMOLE_URL` | `https://stats-guac.example.com/#/client/` | Guacamole 前端地址 |
| `RSTUDIO_PATH` | `C:\Program Files\RStudio\bin\rstudio.exe` | RStudio 安装路径 |
| `MPLUS_PATH` | `C:\Program Files\Mplus\mplus.exe` | Mplus 安装路径 |
| `STATA_PATH` | `C:\Program Files\Stata18\StataSE-64.exe` | Stata 安装路径 |

## 默认账号

| 用户名 | 密码 | 角色 |
|--------|------|------|
| `admin` | `admin123` | 管理员 |
| `user1` | `user123` | 普通用户 |

> 生产环境请对接 AD/LDAP 认证，替换 `app/auth.py` 中的演示密码验证。

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
