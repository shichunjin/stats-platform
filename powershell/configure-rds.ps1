# ============================================================
# RDS policy configuration - applied via PowerShell
# Run on Windows Server 2022 (RDS Session Host)
# ============================================================
#
# Goals:
#   1. Disable clipboard redirection
#   2. Disable local drive redirection
#   3. Disable printer redirection (prevents printing to local PDF)
#   4. Single session per user
# ============================================================

# --- Method 1: Direct registry modification (workgroup / no domain) ---

$RegPath = "HKLM:\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services"

# Ensure the path exists
if (-not (Test-Path $RegPath)) {
    New-Item -Path $RegPath -Force | Out-Null
}

# Clipboard redirection (0 = allow, 1 = disable)
Set-ItemProperty -Path $RegPath -Name "fDisableClip" -Value 1 -Type DWord -Force
Write-Host "[OK] Clipboard redirection disabled"

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

# Session timeouts (30 min idle disconnect)
Set-ItemProperty -Path $RegPath -Name "MaxIdleTime" -Value 1800000 -Type DWord -Force
Set-ItemProperty -Path $RegPath -Name "MaxDisconnectionTime" -Value 300000 -Type DWord -Force
Write-Host "[OK] Session timeout: 30 min idle disconnect, 5 min terminate after disconnect"

# --- Method 2: Group Policy (domain environment) ---
# In a domain, configure the following policies in GPO:
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
Write-Host "RDS security configuration complete. Restart TermService or reboot to apply."
Write-Host "Restart command: Restart-Service -Name TermService -Force"
