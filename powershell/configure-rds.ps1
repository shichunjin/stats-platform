# ============================================================
# RDS policy configuration - applied via PowerShell
# Run on Windows Server 2022 (RDS Session Host)
# ============================================================
#
# Goals:
# 1. Enable clipboard redirection（业务需要复制粘贴；平台侧 GUAC_CLIPBOARD_ENABLED 配合）
# 2. Disable local drive redirection
# 3. Disable printer redirection (prevents printing to local PDF)
# 4. Single session per user
# 5. 不设置会话时间限制（生命周期由平台 reaper 管理，见 docs/multi-vm-desktop-plan.md）
# ============================================================

# --- Method 1: Direct registry modification (workgroup / no domain) ---

$RegPath = "HKLM:\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services"

# Ensure the path exists
if (-not (Test-Path $RegPath)) {
    New-Item -Path $RegPath -Force | Out-Null
}

# Clipboard redirection (0 = allow, 1 = disable) —— 放行，不要关
Set-ItemProperty -Path $RegPath -Name "fDisableClip" -Value 0 -Type DWord -Force
Write-Host "[OK] Clipboard redirection enabled"

# Local drive redirection (fDisableCdm = 1 means disabled)
Set-ItemProperty -Path $RegPath -Name "fDisableCdm" -Value 1 -Type DWord -Force
Write-Host "[OK] Local drive redirection disabled"

# LPT port redirection
Set-ItemProperty -Path $RegPath -Name "fDisableLPT" -Value 1 -Type DWord -Force

# COM port redirection
Set-ItemProperty -Path $RegPath -Name "fDisableCcm" -Value 1 -Type DWord -Force

# Printer redirection
Set-ItemProperty -Path $RegPath -Name "fDisablePnp" -Value 1 -Type DWord -Force
Write-Host "[OK] Printer redirection disabled"

# Single session per user (fSingleSessionPerUser = 1)
Set-ItemProperty -Path $RegPath -Name "fSingleSessionPerUser" -Value 1 -Type DWord -Force
Write-Host "[OK] Single session per user enabled"

# Session timeouts —— 全部清零（不要设空闲踢人/断线注销）
# 旧共享 RDS 时代这里写的是 MaxIdleTime=30min + MaxDisconnectionTime=5min，
# 搬到「一用户一 VM」后实例生命周期由平台 reaper 管（7 天挂起 / 30 天销毁），
# RDP 层再踢人只会让用户莫名其妙掉线。
Set-ItemProperty -Path $RegPath -Name "MaxIdleTime" -Value 0 -Type DWord -Force
Set-ItemProperty -Path $RegPath -Name "MaxDisconnectionTime" -Value 0 -Type DWord -Force
Set-ItemProperty -Path $RegPath -Name "MaxConnectionTime" -Value 0 -Type DWord -Force
Write-Host "[OK] Session time limits cleared (no idle/disconnect timeout)"

# --- Method 2: Group Policy (domain environment) ---
# In a domain, configure the following policies in GPO:
#
# Computer Configuration > Administrative Templates:
#   Windows Components > Remote Desktop Services > Remote Desktop Session Host:
#     - Device and Resource Redirection:
#         Do not allow clipboard redirection = Disabled   ← 剪贴板要放行，别启用
#         Do not allow drive redirection = Enabled
#         Do not allow LPT port redirection = Enabled
#         Do not allow COM port redirection = Enabled
#         Do not allow Plug and Play device redirection = Enabled
#         Do not allow printers to be redirected = Enabled
#     - Session Time Limits:
#         三项全部 = Disabled（不限制空闲/断线时间，交给平台 reaper）
#     - Connections:
#         Restrict Remote Desktop Services users to a single Remote Desktop Services session = Enabled
#         Allow users to connect remotely using Remote Desktop Services = Enabled
#
# User Configuration > Administrative Templates:
#   Windows Components > Remote Desktop Services:
#     - Do not allow clipboard redirection = Disabled   ← 同上，放行
#     - Do not allow drive redirection = Enabled

Write-Host ""
Write-Host "RDS security configuration complete. Restart TermService or reboot to apply."
Write-Host "Restart command: Restart-Service -Name TermService -Force"
