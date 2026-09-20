"""平台配置"""
import os
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # 数据库
    database_url: str = "postgresql+psycopg2://stats:stats123@localhost:5432/stats_platform"

    # JWT
    jwt_secret: str = "change-me-in-production-please-use-a-long-random-string"
    jwt_algorithm: str = "HS256"
    jwt_expire_hours: int = 8

    # 文件服务器根路径
    fileserver_root: str = r"\\fileserver"

    # 远程桌面
    rds_host: str = "10.0.1.100"
    rds_port: int = 3389
    guacamole_url: str = "https://stats-guac.example.com/#/client/"

    # 各软件安装路径 (Windows Server 上)
    rstudio_path: str = r"C:\Program Files\RStudio\bin\rstudio.exe"
    mplus_path: str = r"C:\Program Files\Mplus\mplus.exe"
    stata_path: str = r"C:\Program Files\Stata18\StataSE-64.exe"

    # PowerShell 登录脚本路径
    ps_login_script: str = r"\\fileserver\scripts\login.ps1"

    model_config = {"env_file": ".env"}


settings = Settings()
