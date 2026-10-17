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

    生成物落点强制（对所有软件通用，包括后续新安装的软件）：
      - 桌面/文档/下载重定向到 W: 下子目录，软件"另存为"到这些常见位置时
        实际全部写入本人私有 W: 盘；首次重定向自动迁移存量文件；
      - 普通用户隐藏 C: 盘且标准文件对话框禁止访问 C:（管理员豁免运维）；
      - 文件对话框左侧栏固定 W: / 本人待导出目录 / Z:；
      - W:/pending 的 NTFS ACL 仅本人可写，配合"只有 pending 能申请导出"
        的后端唯一出口，保证任何软件的生成文件都在各自指定目录内。

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
# 3. 生成物落点强制：文件夹重定向 + 隐藏 C: 盘（普通用户；管理员豁免）
# ============================================================
$Identity  = [Security.Principal.WindowsIdentity]::GetCurrent()
$Principal = New-Object Security.Principal.WindowsPrincipal($Identity)
$IsAdmin   = $Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $IsAdmin -and (Test-Path $WDrive)) {
    # 3.1 桌面/文档/下载的物理位置改到 W: 私有工作区下
    $RedirDesktop   = "W:\Desktop"
    $RedirDocuments = "W:\Documents"
    $RedirDownloads = "W:\Downloads"
    foreach ($p in @($RedirDesktop, $RedirDocuments, $RedirDownloads)) {
        New-Item -ItemType Directory -Path $p -Force | Out-Null
    }

    # 3.2 首次重定向：把旧位置的存量文件复制进 W:（不删原件，复制后置标记，幂等）
    $migFlag = "W:\.folder_redir_migrated"
    if (-not (Test-Path $migFlag)) {
        $oldDesktop   = [Environment]::GetFolderPath("Desktop")
        $oldDocuments = [Environment]::GetFolderPath("MyDocuments")
        $shellFoldersKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders"
        $dlGuid = "{374DE290-123F-4565-9164-39C4925E467B}"
        $oldDownloads = (Get-ItemProperty -Path $shellFoldersKey -Name $dlGuid -ErrorAction SilentlyContinue).$dlGuid

        foreach ($pair in @(
            @($oldDesktop,   $RedirDesktop),
            @($oldDocuments, $RedirDocuments),
            @($oldDownloads, $RedirDownloads)
        )) {
            $src, $dst = $pair
            if ($src -and (Test-Path $src) -and ($src -notlike "W:\*")) {
                # robocopy 退出码 0-7 均属成功；/XJ 排除联接点防止递归
                robocopy $src $dst /E /XJ /R:1 /W:1 /NFL /NDL /NJH /NJS | Out-Null
            }
        }
        New-Item -ItemType File -Path $migFlag -Force | Out-Null
    }

    # 3.3 注册表重定向：此后任何软件读写"桌面/文档/下载"都实际落在本人 W: 盘
    $userShellKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders"
    Set-ItemProperty -Path $userShellKey -Name "Desktop"   -Value $RedirDesktop   -Type ExpandString
    Set-ItemProperty -Path $userShellKey -Name "Personal"  -Value $RedirDocuments -Type ExpandString
    Set-ItemProperty -Path $userShellKey -Name "{374DE290-123F-4565-9164-39C4925E467B}" `
                     -Value $RedirDownloads -Type ExpandString

    # 3.4 隐藏 C: 盘并禁止资源管理器/标准"另存为"对话框访问（位掩码 4 = C:；
    #     只影响图形界面浏览，不影响软件从 Program Files 运行；W:/Z: 网络盘不受限）
    $polExplorer = "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\Explorer"
    New-Item -Path $polExplorer -Force | Out-Null
    Set-ItemProperty -Path $polExplorer -Name "NoDrives"       -Value 4 -Type DWord
    Set-ItemProperty -Path $polExplorer -Name "NoViewOnDrive"  -Value 4 -Type DWord

    # 3.5 标准文件对话框左侧栏：我的工作区 / 本人待导出目录 / 原始数据
    $placesKey = "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\ComDlg32\PlacesBar"
    New-Item -Path $placesKey -Force | Out-Null
    New-ItemProperty -Path $placesKey -Name "Place0" -Value "W:\"         -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $placesKey -Name "Place1" -Value $UserPending  -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $placesKey -Name "Place2" -Value "Z:\"         -PropertyType String -Force | Out-Null
}

# ============================================================
# 4. Set registry/environment variables: software working directories
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
# 5. Create desktop shortcuts
# ============================================================
# 普通用户的"桌面"已在第 3 步重定向到 W:\Desktop；同进程 Shell API 可能仍缓存
# 旧路径，这里直接按身份取目标目录，保证快捷方式一次到位。
if ($IsAdmin -or -not (Test-Path $WDrive)) {
    $Desktop = [Environment]::GetFolderPath("Desktop")
} else {
    $Desktop = $RedirDesktop
}
$Shell = New-Object -ComObject WScript.Shell

# 软件快捷方式表：后续新装统计软件时，在此表追加一条即可（key/Path/Name）。
# 快捷方式起始目录一律为 W:，用户打开/保存默认就在本人私有工作区；
# 若该软件支持启动配置（类似 Rprofile.site / profile.do），另需在
# enforce-output-location.ps1 增加对应的启动目录固化段。
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

# Desktop shortcut to the user's own pending dir —— 只有放进这里的结果才能在平台申请导出
if (Test-Path $UserPending) {
    $lnkPath = "$Desktop\待导出目录.lnk"
    $shortcut = $Shell.CreateShortcut($lnkPath)
    $shortcut.TargetPath = "$env:SystemRoot\explorer.exe"
    $shortcut.Arguments = $UserPending
    $shortcut.WorkingDirectory = $UserPending
    $shortcut.IconLocation = "%SystemRoot%\system32\shell32.dll,280"
    $shortcut.Description = "要导出的结果放进此目录，再到平台点申请导出"
    $shortcut.Save()
}

# ============================================================
# 6. RDP 剪贴板/本地盘重定向策略（需要管理员；由 configure-rds.ps1 统一下发，
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
# 7. Launch the specified software
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
