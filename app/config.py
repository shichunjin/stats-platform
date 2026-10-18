"""平台配置

隐私配置（数据库连接串、JWT 密钥）不设置硬编码默认值，必须通过环境变量
或 `.env` 文件提供。缺失时启动会立即报错（fail-fast），避免误用不安全默认值。
"""
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # 运行环境：prod（默认）| dev（本地开发）
    # prod：关闭 /docs /redoc /openapi.json（B11），CORS 白名单不含 localhost（B12）；
    # dev：开启 API 文档，CORS 追加 http://localhost:5173 / http://127.0.0.1:5173。
    # 通过环境变量 APP_ENV=dev 或 .env 中 APP_ENV=dev 切换。
    app_env: str = "prod"

    # 数据库连接串（含密码，必须通过环境变量 DATABASE_URL 提供）
    database_url: str

    # JWT 签名密钥（必须通过环境变量 JWT_SECRET 提供，请使用足够长的随机串）
    jwt_secret: str
    jwt_algorithm: str = "HS256"
    jwt_expire_hours: int = 8

    # 演示账号密码（从环境变量读取；留空则禁用对应演示账号登录）
    demo_admin_password: str = ""
    demo_user_password: str = ""

    # 文件服务器根路径（后端可写目录；生产环境改为挂载到 Windows 文件服务器的本地路径）
    fileserver_root: str = "./fileserver_data"

    # 待导入的原始数据集 CSV 路径
    dataset_csv_path: str = "testData.csv"
    # 数据集名称（生成 Excel 时的文件名前缀）
    dataset_name: str = "testData"

    # 业务数据宽表名（create_testdata_table.py 建的表，/data/fetch 从该表读数据）
    testdata_table: str = "test_data"

    # 导出免审阈值：待导出文件与原始数据集相似度 ≥ 该值（0~1）时必须管理员人工审核，
    # 低于该值系统自动放行；0.6 = 60%
    export_review_similarity_threshold: float = 0.6
    # 免审自动通过的结果，下载有效期（天），与人工审核通过一致
    export_publish_valid_days: int = 30

    # ---- Windows 云主机 SFTP 推送（生成的 Excel 推送到 Windows C:\StatsData） ----
    sftp_host: str = "8.133.223.251"
    sftp_port: int = 22
    sftp_username: str = "Administrator"
    # 私钥路径（Linux 服务器上，免密登录；~ 会自动展开）
    sftp_key_path: str = "~/.ssh/stats_windows"
    sftp_passphrase: str = ""
    # Windows 上的目标目录（SFTP 路径用正斜杠）
    windows_data_dir: str = "C:/StatsData"
    # 用户工作区根目录（获取数据/筛选生成的数据推送到 {该目录}/{用户名}/，对应用户的 W: 盘）
    windows_workspace_dir: str = "C:/workspace"
    # 用户结果暂存根目录（{该目录}/{用户名}/，对应 pending 共享），同样按用户私有隔离
    windows_pending_dir: str = "C:/pending"

    # 注册/改密时是否经 SSH 在 Windows 云主机同步创建/更新同名本地账号
    # （复用 SFTP 的主机与免密私钥；本地开发可设 WINDOWS_ACCOUNT_SYNC=false 关闭）
    windows_account_sync: bool = True

    # 远程桌面
    rds_host: str = "8.133.223.251"
    rds_port: int = 3389
    guacamole_url: str = "https://guac.chunjindevelop68.xyz/guacamole/#/client/"
    # 已废弃（安全修复 A4）：共享 RDP 连接 ID 的回退已移除——未启用 GUAC_DB_URL
    # 时 /session/connect 直接 503，不再回退到共享连接（会话串号风险）。
    # 字段仅为兼容旧 .env 保留，不再被读取。
    guacamole_connection_id: str = "1"
    # Guacamole JDBC 认证数据库连接串（如 postgresql+psycopg2://guac:***@localhost:5432/guacamole_db）。
    # 配置后：注册时同步创建 Guacamole 用户（同密码）及其专属 RDP 连接，改密时同步更新；
    # 留空则不同步（本地开发/测试）。
    guac_db_url: str = ""

    # ---- 一人一专属 RDP 连接（启用 GUAC_DB_URL 时生效） ----
    # 专属连接名前缀，完整连接名 = 前缀 + 用户名
    guac_connection_prefix: str = "windows-"
    # 是否把账号密码写入连接参数实现 RDP 自动登录（要求 Windows 账号与平台账号同名同密码）。
    # 安全修复 B13：默认 False——guacamole-auth-jdbc 以明文存储连接密码，库泄露即
    # Windows 凭据泄露；关闭后用户在 Windows 登录界面手工输入一次凭据（与平台同密码）。
    # 连接参数每次同步全量重写，关闭后存量明文密码随下次同步/连接自动清除。
    # 如确认库仅监听 127.0.0.1 且接受该风险，可设 GUAC_RDP_AUTO_LOGIN=true 恢复一键直连。
    guac_rdp_auto_login: bool = False
    # Windows 域名（工作组环境留空）
    guac_rdp_domain: str = ""
    # RDP 安全层：nla / tls / rdp；留空让 guacd 自动协商
    guac_rdp_security: str = "nla"
    # 忽略 RDP 证书错误（自签证书/按 IP 直连环境建议开启）
    guac_rdp_ignore_cert: bool = True
    # guacd 容器内 RDP 虚拟盘根目录，按用户名建子目录隔离浏览器传文件；留空不启用
    guac_drive_root: str = ""
    # guacd 容器内会话录像根目录，按用户名建子目录隔离；留空不录像
    guac_recording_root: str = ""

    # 各软件安装路径 (Windows Server 上)
    rstudio_path: str = r"C:\Program Files\RStudio\rstudio.exe"
    mplus_path: str = r"C:\Program Files\Mplus Demo\Mpdwin.exe"
    stata_path: str = r"C:\Program Files\Stata18\StataSE-64.exe"

    # PowerShell 登录脚本路径
    ps_login_script: str = r"\\fileserver\scripts\login.ps1"

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


settings = Settings()
