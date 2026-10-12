"""SQLAlchemy ORM 模型"""
from datetime import datetime
from sqlalchemy import (
    Column, Integer, String, Text, BigInteger, Boolean, DateTime, ForeignKey,
    Table, JSON
)
from sqlalchemy.orm import relationship
from app.database import Base

# 用户-范围关联
user_scope = Table(
    "user_scope", Base.metadata,
    Column("user_id", Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
    Column("scope_id", Integer, ForeignKey("scopes.id", ondelete="CASCADE"), primary_key=True),
)


class Scope(Base):
    __tablename__ = "scopes"
    id = Column(Integer, primary_key=True, autoincrement=True)
    scope_code = Column(String(64), unique=True, nullable=False)
    scope_type = Column(String(16), nullable=False)   # dept | project
    scope_name = Column(String(128), nullable=False)
    data_path = Column(String(256), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)


class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, autoincrement=True)
    username = Column(String(64), unique=True, nullable=False)
    ad_sid = Column(String(128))
    display_name = Column(String(128))
    dept_id = Column(Integer, ForeignKey("scopes.id"))
    role = Column(String(16), default="user")        # user | admin
    is_active = Column(Boolean, default=True)
    password_hash = Column(String(256), nullable=True)  # 注册用户密码哈希（演示账号为空）
    created_at = Column(DateTime, default=datetime.utcnow)

    dept = relationship("Scope", foreign_keys=[dept_id])
    scopes = relationship("Scope", secondary=user_scope, backref="users")


class Session(Base):
    __tablename__ = "sessions"
    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    software = Column(String(32), nullable=False)    # rstudio | mplus | stata
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


class DatasetMeta(Base):
    """数据集元数据（列名、行数等）"""
    __tablename__ = "dataset_meta"
    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(128), unique=True, nullable=False)
    column_names = Column(JSON)          # 列名列表（保序）
    total_rows = Column(Integer, default=0)
    created_at = Column(DateTime, default=datetime.utcnow)


class DatasetRow(Base):
    """数据集行数据（每行以 JSON 字典存储，键为列名）"""
    __tablename__ = "dataset_rows"
    id = Column(Integer, primary_key=True, autoincrement=True)
    dataset_id = Column(Integer, ForeignKey("dataset_meta.id"), nullable=False)
    row_index = Column(Integer, nullable=False)
    data = Column(JSON)                  # {列名: 值}

    dataset = relationship("DatasetMeta")


class DataApply(Base):
    """用户数据申请"""
    __tablename__ = "data_applies"
    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    data_name = Column(String(128), default="testData")
    purpose = Column(Text, nullable=False)
    fields = Column(JSON)                # 所需字段列表
    time_start = Column(DateTime)        # 时间范围起
    time_end = Column(DateTime)          # 时间范围止
    priority = Column(String(16), default="medium")   # low | medium | high
    status = Column(String(16), default="pending")    # pending | processing | completed | rejected
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
