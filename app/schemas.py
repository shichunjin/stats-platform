"""Pydantic 请求/响应 Schema"""
from typing import Optional, List
from datetime import datetime
from pydantic import BaseModel, ConfigDict, Field


# ---- Auth ----
class LoginRequest(BaseModel):
    username: str = Field(..., description="用户名", examples=["admin"])
    password: str = Field(..., description="密码", examples=["admin123"])


class RegisterRequest(BaseModel):
    # 用户名同时作为 Windows 本地账号名，遵循 Windows 命名规则：
    # 3-20 位，仅字母数字与 . _ -，不含空格与 " / \ [ ] : ; | = , + * ? < > @
    username: str = Field(..., min_length=3, max_length=20,
                          pattern=r"^[A-Za-z0-9._-]+$",
                          description="用户名（3-20 位字母、数字或 . _ -，将作为 Windows 登录账号）",
                          examples=["newuser"])
    password: str = Field(..., min_length=8, max_length=64,
                          description="密码（8-64 字符，大写/小写/数字/符号至少三类，不含用户名）",
                          examples=["Newuser@2026"])
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


class ChangePasswordRequest(BaseModel):
    old_password: str = Field(..., description="原密码")
    new_password: str = Field(..., min_length=8, max_length=64,
                              description="新密码（8-64 字符，大写/小写/数字/符号至少三类，不含用户名）")


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
    role: str = Field(..., description="角色：user=普通用户 / admin=管理员 / superadmin=超级管理员")
    dept: Optional[ScopeOut] = Field(None, description="所属部门信息")
    scopes: List[ScopeOut] = Field(default_factory=list, description="可访问的数据范围列表")


# ---- Session ----
class SessionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int = Field(..., description="会话 ID")
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
    expires_at: Optional[datetime] = Field(None, description="有效期，过期不可下载（null=永久）")
    created_at: Optional[datetime] = Field(None, description="发布时间")


# ---- Audit ----
class AuditLogOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int = Field(..., description="日志 ID")
    user_id: Optional[int] = Field(None, description="操作者用户 ID")
    action: str = Field(..., description="操作类型（如 login/session_launch/result_approved）")
    detail: Optional[str] = Field(None, description="操作详情")
    ip_addr: Optional[str] = Field(None, description="来源 IP")
    status: str = Field("success", description="结果状态：success / failed")
    created_at: Optional[datetime] = Field(None, description="操作时间")


# ---- Admin ----
class ScopeAssignRequest(BaseModel):
    dept_id: Optional[int] = Field(None, description="所属部门（范围）ID，可为空")
    scope_ids: List[int] = Field(default_factory=list, description="可访问的项目范围 ID 列表")


class ExportReviewRequest(BaseModel):
    reason: Optional[str] = Field(None, description="审核意见（拒绝时建议填写原因）")


class UserAdminOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int = Field(..., description="用户 ID")
    username: str = Field(..., description="用户名")
    display_name: Optional[str] = Field(None, description="显示名称")
    role: str = Field(..., description="角色：user=普通用户 / admin=管理员 / superadmin=超级管理员")
    is_active: bool = Field(..., description="账号是否启用")
    dept_id: Optional[int] = Field(None, description="所属部门范围 ID")
    dept: Optional[ScopeOut] = Field(None, description="所属部门信息")
    scopes: List[ScopeOut] = Field(default_factory=list, description="可访问的数据范围列表")
    created_at: Optional[datetime] = Field(None, description="注册时间")


# ---- 消息中心 ----
class MessageOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    title: str
    content: Optional[str] = None
    type: str = Field("info", description="类型：info/success/warning")
    read: bool = Field(False, description="是否已读")
    link: Optional[str] = Field(None, description="点击跳转路径")
    created_at: Optional[datetime] = None


# ---- 数据申请 ----
class DataApplyCreate(BaseModel):
    purpose: str = Field(..., min_length=1, description="数据用途")
    fields: List[str] = Field(default_factory=list, description="所需字段")
    time_range: Optional[List[Optional[str]]] = Field(None, description="[起始时间, 结束时间] ISO 字符串")
    priority: str = Field("medium", description="优先级：low/medium/high")


class DataApplyOut(BaseModel):
    id: int
    data_name: str
    purpose: str
    fields: List[str] = Field(default_factory=list)
    time_range: Optional[List[Optional[str]]] = None
    priority: str
    status: str
    reject_reason: Optional[str] = None
    apply_time: Optional[datetime] = None
    finish_time: Optional[datetime] = None
    target_user_id: int


class DataApplyRejectRequest(BaseModel):
    reason: str = Field(..., min_length=1, description="驳回原因")


# ---- 数据筛选与生成 ----
class FilteredDataGenerateRequest(BaseModel):
    filters: dict = Field(default_factory=dict, description="筛选条件：列名 -> 值/[min,max]/模糊文本")
    target_user_id: int = Field(..., description="接收数据的目标用户 ID")
    filename: Optional[str] = Field(None, description="目标文件名（含扩展名），留空自动命名")
    apply_id: Optional[int] = Field(None, description="关联的数据申请 ID（可选，生成后自动置为完成）")


class DataColumnOut(BaseModel):
    name: str = Field(..., description="列名")
    type: str = Field(..., description="数据类型：int/float/text")
    control: str = Field(..., description="筛选控件：select/range/input")
    options: Optional[List] = Field(None, description="枚举值（control=select 时）")
    min: Optional[float] = Field(None, description="最小值（control=range 时）")
    max: Optional[float] = Field(None, description="最大值（control=range 时）")
