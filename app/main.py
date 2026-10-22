"""FastAPI 入口 — 统计软件托管平台"""
import logging
import os
from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, RedirectResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from app.routers import auth, session, results, admin, data, messages, applies
from app.database import Base, engine, SessionLocal
from app.models import User, AuditLog
from app.auth import DEMO_ACCOUNTS, DEMO_USERS
from app.config import settings
from app.guac import guac_sync_enabled, upsert_guac_user
from app.windows_account import windows_sync_enabled, sync_windows_user

logger = logging.getLogger("stats-platform")

# 安全修复 B11/B12：按运行环境拆分攻击面
# prod（默认）：/docs /redoc /openapi.json 关闭、CORS 仅含生产域名；
# dev（APP_ENV=dev）：开放 API 文档、CORS 追加本地前端开发地址。
_IS_PROD = settings.app_env.strip().lower() == "prod"

# 创建数据库表（生产环境建议用 Alembic 迁移）
Base.metadata.create_all(bind=engine)


def _migrate_schema():
    """轻量级启动时 schema 迁移：为既有表新增 ORM 中新增的列（幂等）"""
    from sqlalchemy import text, inspect
    insp = inspect(engine)
    if "users" in insp.get_table_names():
        cols = [c["name"] for c in insp.get_columns("users")]
        if "password_version" not in cols:
            with engine.connect() as conn:
                conn.execute(text("ALTER TABLE users ADD COLUMN password_version INTEGER DEFAULT 1"))
                conn.commit()
            logger.info("已迁移: users 表新增 password_version 列")
    if "pending_files" in insp.get_table_names():
        cols = [c["name"] for c in insp.get_columns("pending_files")]
        if "content_sha" not in cols:
            with engine.connect() as conn:
                conn.execute(text("ALTER TABLE pending_files ADD COLUMN content_sha VARCHAR(64)"))
                conn.commit()
            logger.info("已迁移: pending_files 表新增 content_sha 列")
        # 安全修复 B9：同一用户同名同内容仅允许一条 pending/approved 申请，
        # 唯一索引兜底并发双申请导致的重复发布；rejected 不占用唯一位（允许修正后重提）。
        # 部分索引（SQLite/PostgreSQL 均支持）；存量行 content_sha 为 NULL，互不相等，不受影响。
        with engine.connect() as conn:
            conn.execute(text(
                "CREATE UNIQUE INDEX IF NOT EXISTS ix_pending_files_active "
                "ON pending_files (user_id, file_name, content_sha) "
                "WHERE status IN ('pending', 'approved')"
            ))
            conn.commit()

    # 软件维度下线：移除 sessions.software（原 RStudio/Mplus/Stata 专用字段）
    if "sessions" in insp.get_table_names():
        cols = [c["name"] for c in insp.get_columns("sessions")]
        if "software" in cols:
            _drop_sessions_software_column(insp)

    # 角色三档化：内置 admin 账号提升为超级管理员（幂等）。
    # 仅匹配 username='admin' 且当前为 admin 的行，其他管理员不受影响。
    if "users" in insp.get_table_names():
        with engine.connect() as conn:
            res = conn.execute(text(
                "UPDATE users SET role='superadmin' "
                "WHERE username='admin' AND role='admin'"
            ))
            conn.commit()
        if res.rowcount:
            logger.info("已迁移: 内置 admin 账号提升为 superadmin")


def _drop_sessions_software_column(insp):
    """移除 sessions.software 列（软件维度下线，幂等）。

    software 为 NOT NULL 且无默认值：若列残留而代码不再写入，后续
    INSERT INTO sessions 会因 NOT NULL 约束失败、用户无法建立会话，
    因此兜底必须真正完成列移除而非仅告警。
    SQLite ≥ 3.35 直接 DROP COLUMN；更低版本按剩余列重建表并拷贝数据。
    重建 SQL 由 inspector 列元数据拼装（不硬编码列清单），单事务执行，
    失败即回滚，不破坏原表。
    """
    from sqlalchemy import text

    table = "sessions"
    all_cols = insp.get_columns(table)
    remaining = [c for c in all_cols if c["name"] != "software"]
    pk_cols = set(insp.get_pk_constraint(table).get("constrained_columns") or [])
    # 反射结果须在改表前取好（索引随 DROP TABLE 一并消失）
    original_indexes = insp.get_indexes(table)

    try:
        with engine.begin() as conn:
            conn.execute(text(f'ALTER TABLE {table} DROP COLUMN software'))
        logger.info("已迁移: sessions 表移除 software 列")
        return
    except Exception as exc:  # noqa: BLE001 — 旧版 SQLite 不支持 DROP COLUMN
        logger.info("DROP COLUMN 不可用（%s），改用重建表移除 sessions.software", exc)

    names = [c["name"] for c in remaining]
    defs = []
    for c in remaining:
        ddl = f'"{c["name"]}" {c["type"].compile(engine.dialect)}'
        if not c["nullable"]:
            ddl += " NOT NULL"
        defs.append(ddl)
    kept_pk = [n for n in names if n in pk_cols]
    if kept_pk:
        defs.append("PRIMARY KEY (" + ", ".join(f'"{n}"' for n in kept_pk) + ")")
    col_list = ", ".join(f'"{n}"' for n in names)

    with engine.begin() as conn:
        conn.execute(text("CREATE TABLE sessions_new (\n    " + ",\n    ".join(defs) + "\n)"))
        conn.execute(text(f"INSERT INTO sessions_new ({col_list}) SELECT {col_list} FROM {table}"))
        conn.execute(text(f"DROP TABLE {table}"))
        conn.execute(text("ALTER TABLE sessions_new RENAME TO sessions"))
        for idx in original_indexes:
            idx_cols = ", ".join(f'"{n}"' for n in (idx.get("column_names") or []) if n)
            if not idx_cols:
                continue
            unique = "UNIQUE " if idx.get("unique") else ""
            conn.execute(text(
                f'CREATE {unique}INDEX IF NOT EXISTS "{idx["name"]}" ON sessions ({idx_cols})'
            ))
    logger.info("已迁移: sessions 表重建并移除 software 列")


_migrate_schema()


def _init_demo_data():
    """初始化演示账号（仅在不存在时创建）"""
    db = SessionLocal()
    try:
        # 演示账号（仅创建已配置密码的账号）
        for username, (display_name, role) in DEMO_ACCOUNTS.items():
            if username not in DEMO_USERS:
                continue  # 未配置密码，跳过创建
            if not db.query(User).filter(User.username == username).first():
                db.add(User(
                    username=username,
                    display_name=display_name,
                    role=role,
                    is_active=True,
                    # 演示账号不用 password_hash，登录时用 DEMO_USERS 字典校验
                ))
        db.commit()
    finally:
        db.close()

    # 启用 Guacamole 同步时，为演示账号补齐 Windows 账号、Guacamole 用户与
    # 专属连接（失败只告警不阻断启动）。顺序与注册链路一致：先 Windows 后
    # Guacamole，Windows 失败则跳过本次 Guacamole 更新，避免三端凭据分叉
    # （每次重启都以 .env 中的演示密码为准做收敛）。
    if guac_sync_enabled():
        win_sync = windows_sync_enabled()
        for username, password in DEMO_USERS.items():
            if win_sync:
                try:
                    sync_windows_user(username, password)
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "演示账号 %s 同步 Windows 失败，跳过本次 Guacamole 同步: %s",
                        username, exc,
                    )
                    continue
            try:
                upsert_guac_user(username, password)
            except Exception as exc:  # noqa: BLE001
                logger.warning("演示账号 %s 同步 Guacamole 失败: %s", username, exc)


_init_demo_data()

app = FastAPI(
    title="统计软件托管平台",
    description="""
# 统计软件托管平台 API 文档

在 **不修改无源码 Windows 桌面软件** 的前提下，让用户通过浏览器使用 Windows 分析主机上的桌面软件。

## 核心能力

- **软件权限**：所有登录用户都可以使用所有软件（不做软件级权限）
- **数据权限**：每个用户只能看到 / 读取自己部门或项目范围内的数据
- **原始数据保护**：用户不能下载、拷贝、导出原始数据文件
- **结果导出**：分析完成后的"结果数据"可以导出，但必须经过平台审查
- **多用户并行**：多个用户可同时使用同一款软件，互不干扰

## 接口分类

- **认证模块** (`/auth`)：登录、获取当前用户信息
- **会话模块** (`/session`)：启动远程统计软件会话
- **结果模块** (`/results`)：查看/扫描/下载分析结果
- **管理员模块** (`/admin`)：审计日志、待审查文件管理
""",
    version="1.0.0",
    openapi_tags=[
        {"name": "认证", "description": "用户登录与身份验证相关接口"},
        {"name": "用户", "description": "用户信息查询接口"},
        {"name": "会话", "description": "远程统计软件会话管理接口"},
        {"name": "结果", "description": "分析结果审查与下载接口"},
        {"name": "管理员", "description": "管理员专属接口（需管理员权限）"},
    ],
    # 安全修复 B11：生产环境关闭公开 API 文档（完整攻击面清单不对未认证用户暴露）
    docs_url=None if _IS_PROD else "/docs",
    redoc_url=None if _IS_PROD else "/redoc",
    openapi_url=None if _IS_PROD else "/openapi.json",
)

# 安全修复 B12：CORS 按环境拆分——生产仅允许已配置 DNS 的正式域名，
# 本地开发地址（Vite 5173）仅在 APP_ENV=dev 时追加，防止恶意本地页面跨域调用。
_cors_origins = [
    "https://chunjindevelop68.xyz",
    "https://www.chunjindevelop68.xyz",
    "https://guac.chunjindevelop68.xyz",
]
if not _IS_PROD:
    _cors_origins += [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# 安全修复 C4：Content-Security-Policy 等安全响应头。
# Token 存 localStorage 的现状下，CSP 是 XSS 窃取令牌的纵深防御：
# 脚本仅允许同源（Vite 构建产物），样式放行内联（Element Plus 运行时注入），
# 禁止被嵌入 iframe（clickjacking）。
@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data:; font-src 'self' data:; connect-src 'self'; "
        "frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    )
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "same-origin")
    return response

app.include_router(auth.router)
app.include_router(session.router)
app.include_router(results.router)
app.include_router(admin.router)
app.include_router(data.router)
app.include_router(messages.router)
app.include_router(applies.router)


@app.get("/health", tags=["认证"], summary="健康检查", description="检查服务运行状态，无需认证。")
def health():
    return {"status": "ok"}


# ---- 前端页面托管 ----
# 优先托管 Vue 构建产物 frontend/dist（生产）；未构建时回退旧版静态 HTML（本地开发用 5173）
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_FRONTEND_DIST = os.path.join(_REPO_ROOT, "frontend", "dist")
_SPA_INDEX = os.path.join(_FRONTEND_DIST, "index.html")

if os.path.isfile(_SPA_INDEX):
    # hashed 静态资源
    _assets_dir = os.path.join(_FRONTEND_DIST, "assets")
    if os.path.isdir(_assets_dir):
        app.mount("/assets", StaticFiles(directory=_assets_dir), name="assets")

    @app.middleware("http")
    async def spa_history_fallback(request: Request, call_next):
        """浏览器地址栏导航/刷新（Accept: text/html）统一回退到 SPA 入口。

        前端 history 路由与部分 API 路径同名（如 /admin/audit），axios 请求
        不带 text/html，会正常进入 API；仅整页导航命中此前端回退。
        """
        accept = request.headers.get("accept", "")
        if request.method == "GET" and "text/html" in accept:
            path = request.url.path
            if not path.startswith(
                ("/docs", "/redoc", "/openapi.json", "/assets", "/static", "/health")
            ):
                return FileResponse(_SPA_INDEX)
        return await call_next(request)

    @app.get("/{full_path:path}", response_class=HTMLResponse, include_in_schema=False)
    def spa_entry(full_path: str):
        """前端路由（history 模式）统一回退到 index.html；已注册 API 路由优先匹配，不会进入这里。"""
        # 安全修复 B11：docs/redoc/openapi 在生产已关闭，落入 SPA 回退时必须 404
        # （开发环境下这些路径由 FastAPI 内置路由优先匹配，不会走到这里）。
        if full_path == "openapi.json" or full_path.split("/")[0] in ("docs", "redoc"):
            raise HTTPException(status_code=404)
        # dist 根目录下的真实文件（favicon.ico 等）直接返回
        if full_path:
            candidate = os.path.realpath(os.path.join(_FRONTEND_DIST, full_path))
            if candidate.startswith(os.path.realpath(_FRONTEND_DIST) + os.sep) \
                    and os.path.isfile(candidate):
                return FileResponse(candidate)
        return FileResponse(_SPA_INDEX)

else:
    # 未构建前端时的兜底：旧版静态页面 + 根路径服务信息
    _STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
    app.mount("/static", StaticFiles(directory=_STATIC_DIR), name="static")

    @app.get("/", tags=["认证"], summary="服务根路径", description="返回平台基本信息和接口端点列表。")
    def root():
        return {
            "service": "统计软件托管平台",
            "docs": "/docs",
            "login_page": "/login",
            "endpoints": {
                "register": "POST /auth/register",
                "login": "POST /auth/login",
                "me": "GET /auth/me",
                "connect": "POST /session/connect",
                "fetch_data": "POST /data/fetch",
                "my_results": "GET /results/mine",
                "request_export": "POST /results/request-export",
                "download": "POST /results/{id}/download",
                "audit": "GET /admin/audit",
            },
        }

    @app.get("/login", response_class=HTMLResponse, include_in_schema=False)
    def login_page():
        """登录/注册页面"""
        with open(os.path.join(_STATIC_DIR, "login.html"), "r", encoding="utf-8") as f:
            return HTMLResponse(f.read())

    @app.get("/dashboard", response_class=HTMLResponse, include_in_schema=False)
    def dashboard_page():
        """控制台页面"""
        with open(os.path.join(_STATIC_DIR, "dashboard.html"), "r", encoding="utf-8") as f:
            return HTMLResponse(f.read())


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=True)
