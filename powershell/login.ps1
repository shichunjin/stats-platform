<#
.SYNOPSIS
    Stats platform - Windows user login script
.DESCRIPTION
    Maps W: (private, writable workspace keyed by the Windows/平台用户名) and
    optionally re-asserts the user's private folder ACLs, sets software
    environment variables, creates desktop shortcuts, and launches software.

    目录约定（必须与后端 app/config.py 一致）：
      W:      -> \\127.0.0.1\workspace\<用户名>   (C:\workspace\<用户名>)
      pending -> \\127.0.0.1\pending\<用户名>     (C:\pending\<用户名>)
    私有目录由后端在注册/投递数据时创建并锁定 ACL，本脚本不再在共享根下建目录
    （普通用户也无权在共享根创建目录）。

    所有参数均可选：不传入时直接使用当前登录的 Windows 账号名；
    账号名与平台用户名一致（注册时三端同步）。
.NOTES
    Runs as a user login script on Windows Server 2022 (via RDS session startup).
#>

param(
    [string]$Username = "",
    [int]$UserId = 0,
    [int]$DeptId = 0,
    [string]$Software = "",
    [string]$GuacId = ""
)

$ErrorActionPreference = "Stop"

if (-not $Username) { $Username = $env:USERNAME }

# ============================================================
# Path constants
# ============================================================
$FileServer = "\\127.0.0.1"
$WorkspaceRoot = "$FileServer\workspace"
$PendingRoot   = "$FileServer\pending"

$ZDrive = "Z:"
$WDrive = "W:"

# 私有目录一律按用户名（与后端 C:\workspace\{用户名} 对齐；不能再用数字 UserId）
$UserWorkspace = "$WorkspaceRoot\$Username"
$UserPending   = "$PendingRoot\$Username"

# ============================================================
# 1. Map network drives
# ============================================================
# Z: is mapped by the public startup script (map-z-drive.cmd -> \\127.0.0.1\StatsData,
# the shared public dataset). Do NOT touch Z: here to avoid fighting that mapping.

# W: -> user workspace (writable, PRIVATE per user). Backend pre-creates and
# locks the folder; map only when it exists.
if (Test-Path $UserWorkspace) {
    if (Test-Path $WDrive) { net use $WDrive /delete /y | Out-Null }
    net use $WDrive $UserWorkspace /persistent:no | Out-Null
} else {
    Write-Warning "私有工作区不存在（后端尚未开通？）: $UserWorkspace"
}

# ============================================================
# 2. Re-assert folder permissions (W: strictly private per user)
# ============================================================
# 后端在注册/投递时已锁定；这里做幂等兜底。
# SYSTEM/Administrators 使用 SID 形式，避免中文版系统名称本地化问题。
function Lock-PrivateFolder($path) {
    if (-not (Test-Path $path)) { return }
    icacls $path /inheritance:r | Out-Null
    icacls $path /grant "${Username}:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" | Out-Null
}
Lock-PrivateFolder $UserWorkspace
Lock-PrivateFolder $UserPending

# ============================================================
# 3. Set registry/environment variables: software working directories
# ============================================================
# RStudio
[Environment]::SetEnvironmentVariable("RSTUDIO_HOME", $WDrive, "User")
[Environment]::SetEnvironmentVariable("RSTUDIO_DATA_DIR", $ZDrive, "User")

# Mplus
[Environment]::SetEnvironmentVariable("MPLUS_DATA", $ZDrive, "User")
[Environment]::SetEnvironmentVariable("MPLUS_WORK", $WDrive, "User")
[Environment]::SetEnvironmentVariable("MPLUS_RESULTS", $UserPending, "User")

# Stata
[Environment]::SetEnvironmentVariable("STATA_WORK", $WDrive, "User")
[Environment]::SetEnvironmentVariable("STATA_DATA", $ZDrive, "User")

# Common: result output directory
[Environment]::SetEnvironmentVariable("RESULTS_DIR", $UserPending, "User")
if ($UserId -gt 0) {
    [Environment]::SetEnvironmentVariable("USER_ID", $UserId, "User")
}

# ============================================================
# 4. Create desktop shortcuts
# ============================================================
$Desktop = [Environment]::GetFolderPath("Desktop")
$Shell = New-Object -ComObject WScript.Shell

$SoftwareConfigs = @{
    rstudio = @{
        Path = "C:\Program Files\RStudio\rstudio.exe"
        Name = "RStudio"
        Args = ""
    }
    mplus = @{
        Path = "C:\Program Files\Mplus Demo\Mpdwin.exe"
        Name = "Mplus Demo"
        Args = ""
    }
    stata = @{
        Path = "C:\Program Files\Stata18\StataSE-64.exe"
        Name = "Stata SE 18"
        Args = ""
    }
}

# Create shortcuts for all installed software
foreach ($key in $SoftwareConfigs.Keys) {
    $cfg = $SoftwareConfigs[$key]
    if (Test-Path $cfg.Path) {
        $lnkPath = "$Desktop\$($cfg.Name).lnk"
        $shortcut = $Shell.CreateShortcut($lnkPath)
        $shortcut.TargetPath = $cfg.Path
        $shortcut.Arguments = $cfg.Args
        $shortcut.WorkingDirectory = $WDrive
        $shortcut.IconLocation = $cfg.Path
        $shortcut.Save()
    }
}

# Desktop shortcut to the user's own workspace (opens in Explorer)
$lnkPath = "$Desktop\我的工作目录.lnk"
$shortcut = $Shell.CreateShortcut($lnkPath)
$shortcut.TargetPath = "$env:SystemRoot\explorer.exe"
$shortcut.Arguments = $WDrive
$shortcut.WorkingDirectory = $WDrive
$shortcut.IconLocation = "%SystemRoot%\system32\shell32.dll,3"
$shortcut.Description = "打开我的数据工作目录 (W:)"
$shortcut.Save()

# ============================================================
# 5. RDP 剪贴板/本地盘重定向策略（需要管理员；由 configure-rds.ps1 统一下发，
#    普通用户登录时写 HKLM 会失败，这里静默跳过）
# ============================================================
try {
    $TSConfigPath = "HKLM:\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services"
    if (-not (Test-Path $TSConfigPath)) {
        New-Item -Path $TSConfigPath -Force -ErrorAction Stop | Out-Null
    }
    Set-ItemProperty -Path $TSConfigPath -Name "fDisableClip" -Value 1 -Type DWord -ErrorAction Stop
    Set-ItemProperty -Path $TSConfigPath -Name "fDisableCdm" -Value 1 -Type DWord -ErrorAction Stop
} catch {
    # 非管理员会话：策略已在机器级由 configure-rds.ps1 配置，忽略
}

# ============================================================
# 6. Launch the specified software
# ============================================================
if ($Software -and $SoftwareConfigs.ContainsKey($Software.ToLower())) {
    $cfg = $SoftwareConfigs[$Software.ToLower()]
    if (Test-Path $cfg.Path) {
        Start-Process -FilePath $cfg.Path -WorkingDirectory $WDrive
        Write-Host "Launched ${Software}: $($cfg.Path)"
    } else {
        Write-Warning "Software not installed: $($cfg.Path)"
    }
}

Write-Host "========================================"
Write-Host "User $Username login environment initialized"
Write-Host "  Z: (public dataset, read-only) = \\127.0.0.1\StatsData"
Write-Host "  W: (workspace, private)        = $UserWorkspace"
Write-Host "  Result output directory        = $UserPending"
Write-Host "========================================"
