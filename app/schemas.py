"""Pydantic 请求/响应 Schema"""
from typing import Optional, List
from datetime import datetime
from pydantic import BaseModel, ConfigDict, Field


# ---- Auth ----
class LoginRequest(BaseModel):
    username: str = Field(..., description="用户名", examples=["admin"])
    password: str = Field(..., description="密码", examples=["admin123"])


class RegisterRequest(BaseModel):
    username: str = Field(..., min_length=3, max_length=32, description="用户名（3-32 字符）",
                          examples=["newuser"])
    password: str = Field(..., min_length=6, max_length=64, description="密码（6-64 字符）",
                          examples=["newpass123"])
    display_name: Optional[str] = Field(None, max_length=128, description="显示名称（可选）",
                                       examples=["张三"])


class TokenResponse(BaseModel):
    access_token: str = Field(..., description="JWT 访问令牌")
    token_type: str = Field(default="bearer", description="令牌类型")


class RegisterResponse(BaseModel):
    id: int = Field(..., description="新用户 ID")
    username: str = Field(..., description="用户名")
    display_name: Optional[str] = Field(None, description="显示名称")
    role: str = Field(..., description="角色（新注册用户固定为 user）")
    message: str = Field(..., description="提示信息")


# ---- User ----
class ScopeOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int = Field(..., description="数据范围 ID")
    scope_code: str = Field(..., description="数据范围编码（如 dept_1）")
    scope_type: str = Field(..., description="范围类型：dept=部门 / project=项目")
    scope_name: str = Field(..., description="范围名称（如：研发部）")
    data_path: str = Field(..., description="数据目录绝对路径")


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int = Field(..., description="用户 ID")
    username: str = Field(..., description="用户名")
    display_name: Optional[str] = Field(None, description="显示名称")
    role: str = Field(..., description="角色：user=普通用户 / admin=管理员")
    dept: Optional[ScopeOut] = Field(None, description="所属部门信息")
    scopes: List[ScopeOut] = Field(default_factory=list, description="可访问的数据范围列表")


# ---- Session ----
class SessionLaunchRequest(BaseModel):
    software: str = Field(..., description="软件标识：rstudio|mplus|stata")


class SessionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int = Field(..., description="会话 ID")
    software: str = Field(..., description="软件标识：rstudio|mplus|stata")
    status: str = Field(..., description="会话状态：active=活跃 / ended=已结束")
    guac_url: Optional[str] = Field(None, description="Guacamole 浏览器访问 URL")
    launched_at: Optional[datetime] = Field(None, description="会话启动时间")


# ---- Results ----
class PendingFileOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int = Field(..., description="文件记录 ID")
    file_name: str = Field(..., description="文件名")
    file_type: Optional[str] = Field(None, description="文件扩展名（如 csv/png）")
    status: str = Field(..., description="审查状态：pending=待审 / approved=通过 / rejected=拒绝")
    review_reason: Optional[str] = Field(None, description="审查结论/拒绝原因")
    created_at: Optional[datetime] = Field(None, description="记录创建时间")


class ExportResultOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int = Field(..., description="结果 ID")
    result_name: str = Field(..., description="结果文件名")
    file_size: Optional[int] = Field(None, description="文件大小（字节）")
    download_count: int = Field(0, description="累计下载次数")
    created_at: Optional[datetime] = Field(None, description="发布时间")


# ---- Audit ----
class AuditLogOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int = Field(..., description="日志 ID")
    user_id: Optional[int] = Field(None, description="操作者用户 ID")
    action: str = Field(..., description="操作类型（如 login/session_launch/result_approved）")
    detail: Optional[str] = Field(None, description="操作详情")
    ip_addr: Optional[str] = Field(None, description="来源 IP")
    created_at: Optional[datetime] = Field(None, description="操作时间")


# ---- Admin ----
class ScopeAssignRequest(BaseModel):
    dept_id: Optional[int] = Field(None, description="所属部门（范围）ID，可为空")
    scope_ids: List[int] = Field(default_factory=list, description="可访问的项目范围 ID 列表")


class UserAdminOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int = Field(..., description="用户 ID")
    username: str = Field(..., description="用户名")
    display_name: Optional[str] = Field(None, description="显示名称")
    role: str = Field(..., description="角色：user=普通用户 / admin=管理员")
    is_active: bool = Field(..., description="账号是否启用")
    dept_id: Optional[int] = Field(None, description="所属部门范围 ID")
    dept: Optional[ScopeOut] = Field(None, description="所属部门信息")
    scopes: List[ScopeOut] = Field(default_factory=list, description="可访问的数据范围列表")
    created_at: Optional[datetime] = Field(None, description="注册时间")
