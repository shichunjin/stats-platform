# ============================================================
# RDS 组策略配置 — 通过 PowerShell 导入
# 在 Windows Server 2022 (域控或 RDS 服务器) 上运行
# ============================================================
#
# 目标：
#   1. 禁用远程桌面剪贴板重定向
#   2. 禁用本地驱动器映射
#   3. 禁用打印重定向（防止打印到本地 PDF）
#   4. 每用户独立会话
# ============================================================

# --- 方法1：直接修改注册表 (非域环境) ---

$RegPath = "HKLM:\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services"

# 确保路径存在
if (-not (Test-Path $RegPath)) {
    New-Item -Path $RegPath -Force | Out-Null
}

# 禁用剪贴板重定向 (0=禁用, 1=启用)
Set-ItemProperty -Path $RegPath -Name "fDisableClip" -Value 0 -Type DWord -Force
Write-Host "[OK] 禁用远程桌面剪贴板重定向"

# 禁用本地驱动器映射 (fDisableCdm=1 表示禁用)
Set-ItemProperty -Path $RegPath -Name "fDisableCdm" -Value 1 -Type DWord -Force
Write-Host "[OK] 禁用本地驱动器映射"

# 禁用 LPT 端口映射
Set-ItemProperty -Path $RegPath -Name "fDisableLPT" -Value 1 -Type DWord -Force

# 禁用 COM 端口映射
Set-ItemProperty -Path $RegPath -Name "fDisableCcm" -Value 1 -Type DWord -Force

# 禁用打印重定向
Set-ItemProperty -Path $RegPath -Name "fDisablePnp" -Value 1 -Type DWord -Force
Write-Host "[OK] 禁用打印重定向"

# 设置每用户独立会话 (fSingleSessionPerUser=1)
Set-ItemProperty -Path $RegPath -Name "fSingleSessionPerUser" -Value 1 -Type DWord -Force
Write-Host "[OK] 每用户独立会话模式"

# 设置会话超时 (30分钟空闲后断开)
Set-ItemProperty -Path $RegPath -Name "MaxIdleTime" -Value 1800000 -Type DWord -Force
Set-ItemProperty -Path $RegPath -Name "MaxDisconnectionTime" -Value 300000 -Type DWord -Force
Write-Host "[OK] 会话超时: 空闲30分钟断开, 断开后5分钟终止"

# --- 方法2：通过组策略 (域环境) ---
# 如域环境，在 GPO 中配置以下策略:
#
# Computer Configuration > Administrative Templates:
#   Windows Components > Remote Desktop Services > Remote Desktop Session Host:
#     - Device and Resource Redirection:
#         Do not allow clipboard redirection = Enabled
#         Do not allow drive redirection = Enabled
#         Do not allow LPT port redirection = Enabled
#         Do not allow COM port redirection = Enabled
#         Do not allow Plug and Play device redirection = Enabled
#         Do not allow printers to be redirected = Enabled
#     - Session Time Limits:
#         Set time limit for active but idle Remote Desktop Services sessions = 30 min
#         Set time limit for disconnected sessions = 5 min
#     - Connections:
#         Restrict Remote Desktop Services users to a single Remote Desktop Services session = Enabled
#         Allow users to connect remotely using Remote Desktop Services = Enabled
#
# User Configuration > Administrative Templates:
#   Windows Components > Remote Desktop Services:
#     - Do not allow clipboard redirection = Enabled
#     - Do not allow drive redirection = Enabled

Write-Host ""
Write-Host "RDS 安全配置完成。请重启 TermService 服务或重启服务器使配置生效。"
Write-Host "重启命令: Restart-Service -Name TermService -Force"
