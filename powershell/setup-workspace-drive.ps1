# ============================================================
# setup-workspace-drive.ps1
# Windows Server 2022 端配置：C:\workspace / C:\pending 私有共享 + W: 盘
# ============================================================
#
# 完成的工作：
#   1. 创建根目录 C:\workspace、C:\pending，
#      根目录仅允许 Remote Desktop Users 浏览/遍历（不能在根下建目录）
#   2. 共享为 workspace / pending（SMB），开启基于访问的枚举（ABE）：
#      用户在共享根下看不到自己无权访问的他人目录
#   3. 在「所有用户的启动目录」放 map-w-drive.cmd，
#      用户登录后 W: 盘自动映射到 \\127.0.0.1\workspace\<自己的用户名>
#   4. 可选：为已存在的平台用户批量开通/修复私有目录（-ProvisionUsers）
#
# 目录约定（与后端 app/config.py、app/transfer.py 一致）：
#   W: 盘 -> C:\workspace\<用户名>   （获取数据 / 筛选生成的 Excel）
#   结果暂存 -> C:\pending\<用户名>
#   每个用户目录的 NTFS ACL：仅本人 / SYSTEM / Administrators
#
# 用法（以管理员身份运行 PowerShell）：
#
#   .\setup-workspace-drive.ps1
#
#   # 顺便为存量用户开通并递归重置历史文件权限
#   .\setup-workspace-drive.ps1 -ProvisionUsers user1,user2,user3 -ResetExisting
#
# ============================================================
#Requires -RunAsAdministrator
param(
    [string[]]$ProvisionUsers = @(),
    [switch]$ResetExisting
)

$ErrorActionPreference = "Stop"

# 语言无关：Remote Desktop Users 用 SID 解析显示名（icacls 直接支持 *SID 形式）
$sidRdu = New-Object System.Security.Principal.SecurityIdentifier("S-1-5-32-555")
$rduName = $sidRdu.Translate([System.Security.Principal.NTAccount]).Value
$domain, $name = $rduName -split '\\', 2
if ($domain) { $rduName = $name }

function Initialize-PrivateRoot($path, $shareName) {
    if (-not (Test-Path $path)) {
        New-Item -ItemType Directory -Path $path -Force | Out-Null
    }

    # 根目录：断开继承；RDU 仅当前目录遍历/读取（不带继承标志），
    # SYSTEM/Administrators 完全控制。普通用户无法在根下自建目录。
    icacls $path /inheritance:r | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "icacls 根目录初始化失败: $path" }
    icacls $path /grant "*S-1-5-32-555:(RX)" "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "icacls 根目录授权失败: $path" }

    $share = Get-SmbShare -Name $shareName -ErrorAction SilentlyContinue
    if ($null -eq $share) {
        New-SmbShare -Name $shareName -Path $path `
            -ChangeAccess $rduName -FullAccess "Administrators" | Out-Null
        Write-Host "      共享 \\localhost\$shareName 已创建。" -ForegroundColor Green
    } else {
        Write-Host "      共享 $shareName 已存在，跳过创建。" -ForegroundColor Green
    }
    # 基于访问的枚举（Access-Based Enumeration）：只列出当前用户有权限的目录
    Set-SmbShare -Name $shareName -FolderEnumerationMode AccessBased -Force
}

function Lock-UserFolder($root, $userName, [switch]$deep) {
    if ($userName -notmatch '^[A-Za-z][A-Za-z0-9._-]{2,19}$') {
        Write-Warning "跳过非法用户名: $userName"
        return
    }
    $d = Join-Path $root $userName
    if (-not (Test-Path $d)) {
        New-Item -ItemType Directory -Path $d -Force | Out-Null
    }
    icacls $d /inheritance:r /grant "${userName}:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "icacls 用户目录锁定失败: $d" }
    if ($deep -and (Get-ChildItem -LiteralPath $d -Force -ErrorAction SilentlyContinue)) {
        icacls (Join-Path $d '*') /T /C /inheritance:r /grant "${userName}:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "icacls 历史文件递归重置失败: $d" }
    }
    Write-Host "      $d 已锁定为仅 $userName / SYSTEM / Administrators。" -ForegroundColor Green
}

Write-Host "[1/3] 初始化私有目录根与 SMB 共享..." -ForegroundColor Yellow
Initialize-PrivateRoot "C:\workspace" "workspace"
Initialize-PrivateRoot "C:\pending"   "pending"

Write-Host "[2/3] 配置登录自动映射 W: 盘..." -ForegroundColor Yellow
$CommonStartup = "C:\ProgramData\Microsoft\Windows\Start Menu\Programs\StartUp"
$MapScript = Join-Path $CommonStartup "map-w-drive.cmd"
$cmdContent = @'
@echo off
net use W: /delete /y >nul 2>&1
net use W: \\127.0.0.1\workspace\%USERNAME% /persistent:no >nul 2>&1
'@
Set-Content -Path $MapScript -Value $cmdContent -Encoding ASCII
Write-Host "      登录脚本已放置: $MapScript" -ForegroundColor Green
Write-Host "      用户登录后 W: 盘 = \\127.0.0.1\workspace\<用户名>（私有）" -ForegroundColor Green

Write-Host "[3/3] 开通存量用户私有目录..." -ForegroundColor Yellow
if ($ProvisionUsers.Count -eq 0) {
    Write-Host "      未指定 -ProvisionUsers；新注册用户由后端自动开通。" -ForegroundColor DarkGray
} else {
    foreach ($u in $ProvisionUsers) {
        Lock-UserFolder "C:\workspace" $u -deep:$ResetExisting
        Lock-UserFolder "C:\pending"   $u -deep:$ResetExisting
    }
}

Write-Host ""
Write-Host "完成。注意：" -ForegroundColor Cyan
Write-Host "  - 已登录的用户需重新登录（或手动 net use W: ...）才能看到 W: 盘。" -ForegroundColor Cyan
Write-Host "  - 历史上推送到 C:\StatsData（Z: 盘公共区）的按人数据文件需另行清理。" -ForegroundColor Cyan
