# ============================================================
# setup-sftp-datadrive.ps1
# Windows Server 2022 端配置：OpenSSH Server + C:\StatsData + Z: 盘
# ============================================================
#
# 完成的工作：
#   1. 安装并启动 OpenSSH Server（供 Linux 后端 SFTP 推送 Excel）
#   2. 创建 C:\StatsData，Remote Desktop Users 只读、Administrators 完全控制
#   3. 将 C:\StatsData 共享为 StatsData（SMB）
#   4. 在「所有用户的启动目录」放 map-z-drive.cmd，
#      每个用户登录后自动把 Z: 盘映射到 \\127.0.0.1\StatsData
#   5. 把 Linux 端公钥写入 administrators_authorized_keys（免密 SFTP）
#
# 用法（以管理员身份运行 PowerShell）：
#
#   # 方式A：直接传入公钥字符串
#   .\setup-sftp-datadrive.ps1 -SshPublicKey "ssh-ed25519 AAAAC3Nz... root@host"
#
#   # 方式B：从公钥文件读取（先把 .pub 文件拷到本机）
#   .\setup-sftp-datadrive.ps1 -SshPublicKeyFile C:\Temp\stats_windows.pub
#
#   # 不传公钥：只配置环境，稍后手工添加（重复运行本脚本即可补加）
#   .\setup-sftp-datadrive.ps1
#
# 注意：
#   - 阿里云安全组需放行本机 22 端口（TCP）
#   - 脚本可重复运行，已完成的步骤会自动跳过
#   - 已经登录的用户需注销重登，Z: 盘映射才会生效
# ============================================================

[CmdletBinding()]
param(
    # Linux 端 SSH 公钥字符串
    [string]$SshPublicKey,

    # Linux 端 SSH 公钥文件路径（如 stats_windows.pub）
    [string]$SshPublicKeyFile
)

$ErrorActionPreference = "Stop"

# ============================================================
# 0. 管理员权限检查
# ============================================================
function Test-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Admin)) {
    Write-Error "请以管理员身份运行 PowerShell。"
    exit 1
}

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host " Windows 端：OpenSSH + C:\StatsData + Z: 盘配置" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""

# ============================================================
# 1. 安装 OpenSSH Server
# ============================================================
Write-Host "[1/5] 检查并安装 OpenSSH Server..." -ForegroundColor Yellow

$sshCapability = Get-WindowsCapability -Online | Where-Object { $_.Name -like "OpenSSH.Server*" }
if ($sshCapability.State -eq "Installed") {
    Write-Host "      OpenSSH Server 已安装，跳过。" -ForegroundColor Green
} else {
    Add-WindowsCapability -Online -Name $sshCapability.Name | Out-Null
    Write-Host "      OpenSSH Server 安装完成。" -ForegroundColor Green
}

# 启动并设为自动
$sshd = Get-Service -Name sshd -ErrorAction SilentlyContinue
if ($null -eq $sshd) {
    Write-Error "sshd 服务未找到，OpenSSH 安装可能失败。"
    exit 1
}
if ($sshd.StartType -ne "Automatic") {
    Set-Service -Name sshd -StartupType Automatic
}
if ($sshd.Status -ne "Running") {
    Start-Service sshd
}
Write-Host "      sshd 服务已启动并设为开机自启。" -ForegroundColor Green

# 防火墙规则（安装时通常自动创建，没有就补一条）
$fwRule = Get-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -ErrorAction SilentlyContinue
if ($null -eq $fwRule) {
    New-NetFirewallRule -Name "OpenSSH-Server-In-TCP" `
        -DisplayName "OpenSSH Server (sshd)" -Enabled True `
        -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Null
    Write-Host "      已创建 22 端口入站防火墙规则。" -ForegroundColor Green
}

# ============================================================
# 2. 创建 C:\StatsData 并设置 NTFS 权限
# ============================================================
Write-Host "[2/5] 创建数据目录 C:\StatsData..." -ForegroundColor Yellow

$DataDir = "C:\StatsData"
if (-not (Test-Path $DataDir)) {
    New-Item -Path $DataDir -ItemType Directory -Force | Out-Null
}

# Remote Desktop Users：只读（防止用户篡改/删除共享数据）
$acl = Get-Acl $DataDir
$readRule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    "Remote Desktop Users", "ReadAndExecute",
    "ContainerInherit,ObjectInherit", "None", "Allow"
)
if (-not ($acl.Access | Where-Object {
    $_.IdentityReference -eq $readRule.IdentityReference -and
    $_.FileSystemRights -eq "ReadAndExecute"
})) {
    $acl.SetAccessRule($readRule)
    Set-Acl -Path $DataDir -AclObject $acl
}
Write-Host "      C:\StatsData 已就绪（Remote Desktop Users 只读）。" -ForegroundColor Green

# ============================================================
# 3. 共享为 StatsData（供 Z: 盘通过回环 SMB 映射）
# ============================================================
Write-Host "[3/5] 配置 SMB 共享 StatsData..." -ForegroundColor Yellow

$share = Get-SmbShare -Name "StatsData" -ErrorAction SilentlyContinue
if ($null -eq $share) {
    New-SmbShare -Name "StatsData" -Path $DataDir `
        -ReadAccess "Remote Desktop Users" `
        -FullAccess "Administrators" | Out-Null
    Write-Host "      共享 \\localhost\StatsData 创建完成。" -ForegroundColor Green
} else {
    Write-Host "      共享 StatsData 已存在，跳过。" -ForegroundColor Green
}

# ============================================================
# 4. 所有用户登录时自动映射 Z: 盘
# ============================================================
Write-Host "[4/5] 配置登录自动映射 Z: 盘..." -ForegroundColor Yellow

$CommonStartup = "C:\ProgramData\Microsoft\Windows\Start Menu\Programs\StartUp"
$MapScript = Join-Path $CommonStartup "map-z-drive.cmd"

$cmdContent = @'
@echo off
net use Z: /delete /y >nul 2>&1
net use Z: \\127.0.0.1\StatsData /persistent:no
'@

Set-Content -Path $MapScript -Value $cmdContent -Encoding ASCII
Write-Host "      登录脚本已放置: $MapScript" -ForegroundColor Green
Write-Host "      用户登录后 Z: 盘 = \\127.0.0.1\StatsData" -ForegroundColor Green

# ============================================================
# 5. 安装 Linux 公钥到 administrators_authorized_keys
# ============================================================
Write-Host "[5/5] 配置 SSH 免密公钥..." -ForegroundColor Yellow

# 解析公钥来源
$key = ""
if ($SshPublicKey) {
    $key = $SshPublicKey.Trim()
} elseif ($SshPublicKeyFile) {
    if (-not (Test-Path $SshPublicKeyFile)) {
        Write-Error "公钥文件不存在: $SshPublicKeyFile"
        exit 1
    }
    $key = (Get-Content $SshPublicKeyFile -Raw).Trim()
}

$AdminKeys = "C:\ProgramData\ssh\administrators_authorized_keys"

if ($key) {
    $existing = @()
    if (Test-Path $AdminKeys) {
        $existing = Get-Content $AdminKeys | Where-Object { $_.Trim() -ne "" }
    }
    if ($existing -notcontains $key) {
        Add-Content -Path $AdminKeys -Value $key -Encoding ASCII
        Write-Host "      公钥已写入 $AdminKeys" -ForegroundColor Green
    } else {
        Write-Host "      公钥已存在，跳过。" -ForegroundColor Green
    }
} else {
    Write-Host "      未提供公钥，跳过（稍后可用 -SshPublicKey 补加）。" -ForegroundColor Yellow
}

# 关键：administrators_authorized_keys 必须只有 Administrators/SYSTEM 可访问，
# 否则 sshd 出于安全考虑会忽略该文件导致免密登录失败
if (Test-Path $AdminKeys) {
    icacls $AdminKeys /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F" | Out-Null
    Write-Host "      公钥文件权限已修正（仅 Administrators / SYSTEM）。" -ForegroundColor Green
}

# ============================================================
# 完成
# ============================================================
Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host " 配置完成！" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host " 请确认："
Write-Host "   1. 阿里云安全组已放行 TCP 22 端口"
Write-Host "   2. Linux 端已执行：ssh-keygen -t ed25519 -f ~/.ssh/stats_windows -N ''"
Write-Host "   3. 已登录的用户需注销后重新登录，Z: 盘映射才会生效"
Write-Host ""
Write-Host " 验证（在 Linux 后端执行）："
Write-Host "   ssh -i ~/.ssh/stats_windows Administrator@8.133.223.251"
Write-Host ""
