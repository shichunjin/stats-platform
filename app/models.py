"""SQLAlchemy ORM 模型"""
from datetime import datetime
from sqlalchemy import (
    Column, Integer, String, Text, BigInteger, Boolean, DateTime, ForeignKey,
    JSON
)
from sqlalchemy.orm import relationship
from app.database import Base


class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, autoincrement=True)
    username = Column(String(64), unique=True, nullable=False)
    ad_sid = Column(String(128))
    display_name = Column(String(128))
    role = Column(String(16), default="user")        # user | admin | superadmin
    is_active = Column(Boolean, default=True)
    password_hash = Column(String(256), nullable=True)  # 注册用户密码哈希（演示账号为空）
    password_version = Column(Integer, default=1)       # 改密递增，用于 JWT 失效
    created_at = Column(DateTime, default=datetime.utcnow)


class Session(Base):
    __tablename__ = "sessions"
    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    win_session_id = Column(String(128))
    guac_identifier = Column(String(128))
    status = Column(String(16), default="pending")    # pending|active|ended
    launched_at = Column(DateTime, default=datetime.utcnow)
    ended_at = Column(DateTime)

    user = relationship("User")


class PendingFile(Base):
    __tablename__ = "pending_files"
    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    session_id = Column(Integer, ForeignKey("sessions.id"))
    file_name = Column(String(256), nullable=False)
    file_path = Column(String(512), nullable=False)
    file_size = Column(BigInteger)
    file_type = Column(String(16))
    # 申请时文件内容 SHA256（B9）：审核通过前复核，防「申请后改写文件」绕过审查
    content_sha = Column(String(64))
    status = Column(String(16), default="pending")    # pending|approved|rejected
    review_reason = Column(Text)
    reviewed_at = Column(DateTime)
    reviewed_by = Column(Integer, ForeignKey("users.id"))
    created_at = Column(DateTime, default=datetime.utcnow)

    user = relationship("User", foreign_keys=[user_id])


class ExportResult(Base):
    __tablename__ = "export_results"
    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    pending_file_id = Column(Integer, ForeignKey("pending_files.id"))
    result_name = Column(String(256), nullable=False)
    file_path = Column(String(512), nullable=False)
    file_size = Column(BigInteger)
    download_count = Column(Integer, default=0)
    expires_at = Column(DateTime)                    # 有效期，过期不可下载（null = 永久有效）
    created_at = Column(DateTime, default=datetime.utcnow)

    user = relationship("User", foreign_keys=[user_id])
    pending_file = relationship("PendingFile", foreign_keys=[pending_file_id])


class AuditLog(Base):
    __tablename__ = "audit_logs"
    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"))
    action = Column(String(64), nullable=False)
    detail = Column(Text)
    ip_addr = Column(String(64))
    status = Column(String(16), default="success")   # 结果状态：success | failed
    created_at = Column(DateTime, default=datetime.utcnow)


class DataApply(Base):
    """用户数据申请"""
    __tablename__ = "data_applies"
    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    data_name = Column(String(128), default="testData")
    purpose = Column(Text, nullable=False)
    fields = Column(JSON)                # 所需字段列表
    filters = Column(JSON)               # 用户提交的筛选条件（列名 -> 值/[min,max]/模糊文本）
    time_start = Column(DateTime)        # 时间范围起
    time_end = Column(DateTime)          # 时间范围止
    priority = Column(String(16), default="medium")   # low | medium | high
    status = Column(String(16), default="pending")    # pending | processing | generating | completed | failed | rejected
    reject_reason = Column(Text)
    processed_by = Column(Integer, ForeignKey("users.id"))
    finished_at = Column(DateTime)
    created_at = Column(DateTime, default=datetime.utcnow)

    user = relationship("User", foreign_keys=[user_id])


class Message(Base):
    """站内消息（管理员处理完成后通知用户）"""
    __tablename__ = "messages"
    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    title = Column(String(256), nullable=False)
    content = Column(Text)
    msg_type = Column(String(16), default="info")     # info | success | warning
    link = Column(String(256))                        # 点击跳转的前端路径
    is_read = Column(Boolean, default=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    user = relationship("User")


class GuacAuthToken(Base):
    """Guacamole 免密直连令牌（登录时换取，按用户缓存）

    仅保存 authToken 与过期时间，不保存用户密码；每次登录/改密会覆盖旧值，
    过期后由连接接口自动清除并回退为 Guacamole 正常登录。
    """
    __tablename__ = "guac_auth_tokens"
    user_id = Column(Integer, ForeignKey("users.id"), primary_key=True)
    auth_token = Column(Text, nullable=False)
    expires_at = Column(DateTime, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class PlatformConfig(Base):
    """平台连接配置（安全修复 C4：管理端「连接数据分析PC」保存真正落库）

    key/value 形式存储：host / port / username / workspace_dir / output_path。
    读取时以环境变量（.env）为兜底；数据生成投递目录优先取库中 workspace_dir。
    密码永不落库——测试连接时临时输入，仅用于当次 SSH 探测。
    """
    __tablename__ = "platform_config"
    key = Column(String(64), primary_key=True)
    value = Column(Text)
    updated_by = Column(Integer, ForeignKey("users.id"))
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
