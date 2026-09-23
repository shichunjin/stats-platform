"""平台配置

隐私配置（数据库连接串、JWT 密钥）不设置硬编码默认值，必须通过环境变量
或 `.env` 文件提供。缺失时启动会立即报错（fail-fast），避免误用不安全默认值。
"""
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # 数据库连接串（含密码，必须通过环境变量 DATABASE_URL 提供）
    database_url: str

    # JWT 签名密钥（必须通过环境变量 JWT_SECRET 提供，请使用足够长的随机串）
    jwt_secret: str
    jwt_algorithm: str = "HS256"
    jwt_expire_hours: int = 8

    # 演示账号密码（从环境变量读取；留空则禁用对应演示账号登录）
    demo_admin_password: str = ""
    demo_user_password: str = ""

    # 文件服务器根路径
    fileserver_root: str = r"\\fileserver"

    # 远程桌面
    rds_host: str = "8.133.223.251"
    rds_port: int = 3389
    guacamole_url: str = "https://guac.chunjindevelop68.xyz/#/client/"

    # 各软件安装路径 (Windows Server 上)
    rstudio_path: str = r"C:\Program Files\RStudio\bin\rstudio.exe"
    mplus_path: str = r"C:\Program Files\Mplus\mplus.exe"
    stata_path: str = r"C:\Program Files\Stata18\StataSE-64.exe"

    # PowerShell 登录脚本路径
    ps_login_script: str = r"\\fileserver\scripts\login.ps1"

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


settings = Settings()
