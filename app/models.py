"""SQLAlchemy ORM 模型"""
from datetime import datetime
from sqlalchemy import (
    Column, Integer, String, Text, BigInteger, Boolean, DateTime, ForeignKey,
    Table
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
    created_at = Column(DateTime, default=datetime.utcnow)
