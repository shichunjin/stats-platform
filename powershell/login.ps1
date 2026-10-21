<#
.SYNOPSIS
    Stats platform - Windows user login script
.DESCRIPTION
    Maps W: (private, writable workspace keyed by the Windows/平台用户名) and
    optionally re-asserts the user's private folder ACLs, sets common
    environment variables, creates desktop shortcuts from the software
    registry (software-registry.json), and optionally launches a registered software.

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
# 持久化映射（/persistent:yes）：Windows 在资源管理器启动前就会恢复持久映射，
# 否则 Explorer 先读到"桌面 -> W:\Desktop"而 W: 尚未映射，登录时会弹"位置不可用"。
if (Test-Path $UserWorkspace) {
    if (Test-Path $WDrive) { net use $WDrive /delete /y | Out-Null }
    net use $WDrive $UserWorkspace /persistent:yes | Out-Null
    # net use 返回即驱动器可用，但同进程 Test-Path 偶发拿不到状态；强制刷新并重试
    if (-not (Test-Path $WDrive)) {
        $ShellProbe = New-Object -ComObject Shell.Application
        $ShellProbe.NameSpace($WDrive) | Out-Null
        Start-Sleep -Milliseconds 300
    }
} else {
    Write-Warning "私有工作区不存在（后端尚未开通？）: $UserWorkspace"
}

# ============================================================
# 2. Re-assert folder permissions (W: strictly private per user)
# ============================================================
# 后端在注册/投递时已锁定；这里做幂等兜底。
# SYSTEM/Administrators 使用 SID 形式，避免中文版系统名称本地化问题。
# 注意：$IsAdmin 必须在此之前定义（本段及第 3 段都依赖）。
$Identity  = [Security.Principal.WindowsIdentity]::GetCurrent()
$Principal = New-Object Security.Principal.WindowsPrincipal($Identity)
$IsAdmin   = $Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

function Lock-PrivateFolder($path) {
    if (-not (Test-Path $path)) { return }
    # 仅管理员（后端 SSH 通道）可重申 ACL：共享授权为 Change 级别，不含改 ACL 权限，
    # 普通用户经 UNC 调 icacls 必然"拒绝访问"（输出噪音且无意义），跳过。
    if (-not $IsAdmin) { return }
    icacls $path /inheritance:r | Out-Null
    icacls $path /grant "${Username}:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" | Out-Null
}
Lock-PrivateFolder $UserWorkspace
Lock-PrivateFolder $UserPending

# ============================================================
# 3. 桌面/文档/下载 归位本地默认（普通用户；管理员豁免）
# ============================================================
# 需求变更：W: 仅作数据工作区，不再承接桌面/文档/下载等个人 shell 文件夹。
# 本段做两件事（幂等，可反复执行）：
#   ① 若此前曾被本脚本重定向到 W:\，把 W:\Desktop / W:\Documents / W:\Downloads
#      里的存量内容增量搬回本地默认目录（不删 W: 原件）；
#   ② 注册表 User Shell Folders / Shell Folders 指回本地默认路径，
#      此后任何软件读写"桌面/文档/下载"都落在 C:\Users\<用户名>\ 下。
if (-not $IsAdmin) {
    $userShellKey   = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders"
    $shellFoldersKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders"
    $dlGuid = "{374DE290-123F-4565-9164-39C4925E467B}"

    $profileDir = $env:USERPROFILE
    $defaultDesktop   = "$profileDir\Desktop"
    $defaultDocuments = "$profileDir\Documents"
    $defaultDownloads = "$profileDir\Downloads"
    foreach ($p in @($defaultDesktop, $defaultDocuments, $defaultDownloads)) {
        New-Item -ItemType Directory -Path $p -Force | Out-Null
    }

    # ① 存量回搬（仅当注册表当前指向 W:\ 时执行一次）
    $curDesktop   = (Get-ItemProperty -Path $userShellKey -Name "Desktop" -ErrorAction SilentlyContinue).Desktop
    $curDocuments = (Get-ItemProperty -Path $userShellKey -Name "Personal" -ErrorAction SilentlyContinue).Personal
    $curDownloads = (Get-ItemProperty -Path $userShellKey -Name $dlGuid -ErrorAction SilentlyContinue).$dlGuid

    foreach ($pair in @(
        @($curDesktop,   "W:\Desktop",   $defaultDesktop,   "Desktop"),
        @($curDocuments, "W:\Documents", $defaultDocuments, "Personal"),
        @($curDownloads, "W:\Downloads", $defaultDownloads, $dlGuid)
    )) {
        $cur, $wsrc, $dst, $name = $pair
        if ($cur -like "W:\*" -and (Test-Path $wsrc)) {
            robocopy $wsrc $dst /E /XJ /R:1 /W:1 /NFL /NDL /NJH /NJS /XF desktop.ini | Out-Null
        }
        # ② 注册表归位（无论此前是否重定向，统一写回本地默认，幂等）
        Set-ItemProperty -Path $userShellKey   -Name $name -Value $dst -Type ExpandString
        Set-ItemProperty -Path $shellFoldersKey -Name $name -Value $dst -Type String
    }

    # 隐藏 C: 盘策略 + 文件对话框左侧栏（保留原有安全策略，与 shell 文件夹归位无关）
    try {
        $polExplorer = "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\Explorer"
        New-Item -Path $polExplorer -Force -ErrorAction Stop | Out-Null
        Set-ItemProperty -Path $polExplorer -Name "NoDrives"       -Value 4 -Type DWord -ErrorAction Stop
        Set-ItemProperty -Path $polExplorer -Name "NoViewOnDrive"  -Value 4 -Type DWord -ErrorAction Stop

        $placesKey = "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\ComDlg32\PlacesBar"
        New-Item -Path $placesKey -Force -ErrorAction Stop | Out-Null
        New-ItemProperty -Path $placesKey -Name "Place0" -Value "W:\"         -PropertyType String -Force -ErrorAction Stop | Out-Null
        New-ItemProperty -Path $placesKey -Name "Place1" -Value $UserPending  -PropertyType String -Force -ErrorAction Stop | Out-Null
        New-ItemProperty -Path $placesKey -Name "Place2" -Value "Z:\"         -PropertyType String -Force -ErrorAction Stop | Out-Null
    } catch {
        Write-Warning "HKCU\Policies 不可写（安全基线锁定），跳过隐藏C盘/自定义侧栏：$($_.Exception.Message)"
    }
}

# ============================================================
# 4. Set common environment variables（结果目录等，与具体软件无关）
# ============================================================
# Common: result output directory
[Environment]::SetEnvironmentVariable("RESULTS_DIR", $UserPending, "User")
if ($UserId -gt 0) {
    [Environment]::SetEnvironmentVariable("USER_ID", $UserId, "User")
}

# ============================================================
# 5. Create desktop shortcuts
# ============================================================
# 桌面已归位本地默认（第 3 段）；同进程 Shell API 可能仍缓存旧路径，按身份取目标目录。
# 兜底链：$env:USERPROFILE\Desktop（本地默认）→ 显式组装。
# 绝不回退到 COM 惰性解析（在 Desktop 注册表值刚被本脚本改过的窗口期，它会把
# 基址解析成当前目录 C:\，导致快捷方式写进 C 盘根目录触发拒绝访问）。
$Desktop = [Environment]::GetFolderPath("Desktop")
if ([string]::IsNullOrWhiteSpace($Desktop)) { $Desktop = Join-Path $env:USERPROFILE "Desktop" }
$Shell = New-Object -ComObject WScript.Shell

# 软件快捷方式表来自同目录的 software-registry.json（运维手工维护并复制到本机，
# 平台不参与管理）。条目格式（JSON 数组）：
#   [{ "key": "myapp", "name": "MyApp", "path": "C:\\Program Files\\MyApp\\myapp.exe", "args": "" }]
# 快捷方式起始目录一律为 W:，用户打开/保存默认就在本人私有工作区；
# 仅当 path 在本机存在时才创建，未安装的软件不会产生快捷方式。
# 新接入软件若需要固化启动目录（软件专有的启动配置机制），
# 另需在 enforce-output-location.ps1 增加对应处理段。
$RegistryPath = Join-Path $PSScriptRoot 'software-registry.json'
$SoftwareConfigs = @()
if (Test-Path $RegistryPath) {
    try {
        # 注意：PowerShell 5.1 的 ConvertFrom-Json 会把顶层数组当作单个对象输出，
        # 若外面直接套 @(...)，会得到"1 个元素、元素本身是数组"的嵌套结构，
        # 导致 $cfg 是整组数组、$cfg.path 返回 Object[]。必须先赋值给变量再展开。
        $parsedRegistry = Get-Content $RegistryPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $SoftwareConfigs = @($parsedRegistry) | Where-Object { $_ -and $_.path }
    } catch {
        Write-Warning "软件注册表解析失败，本次跳过软件快捷方式创建：$($_.Exception.Message)"
    }
} else {
    Write-Warning "未找到软件注册表 $RegistryPath，本次跳过软件快捷方式创建。"
}

# Create shortcuts for all registered & installed software
foreach ($cfg in $SoftwareConfigs) {
    if (Test-Path $cfg.path) {
        $lnkPath = "$Desktop\$($cfg.name).lnk"
        $shortcut = $Shell.CreateShortcut($lnkPath)
        $shortcut.TargetPath = $cfg.path
        $shortcut.Arguments = $cfg.args
        $shortcut.WorkingDirectory = $WDrive
        $shortcut.IconLocation = $cfg.path
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
# 目录缺失时自动创建（后端会在连接时幂等补建；此处兜底确保快捷方式始终可见），
# 建好后立即锁定为本人私有 ACL
if (-not (Test-Path $UserPending)) {
    try { New-Item -ItemType Directory -Path $UserPending -Force | Out-Null } catch { }
}
if (Test-Path $UserPending) {
    Lock-PrivateFolder $UserPending
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
# 按注册表 key 匹配启动（key 与 $Software 均按小写比较）
if ($Software) {
    $cfg = $SoftwareConfigs |
        Where-Object { $_.key -eq $Software.ToLower() } |
        Select-Object -First 1
    if ($cfg -and (Test-Path $cfg.path)) {
        Start-Process -FilePath $cfg.path -WorkingDirectory $WDrive
        Write-Host "Launched ${Software}: $($cfg.path)"
    } elseif ($cfg) {
        Write-Warning "Software not installed: $($cfg.path)"
    } else {
        Write-Warning "Software not registered: $Software"
    }
}

# ============================================================
# 7. Restart Explorer to clear W: drive state cache
# ============================================================
# Explorer 在登录时可能缓存 W: 的旧状态（目录/ACL 未就绪时的失败状态），
# 导致后续即使路径可用也拒绝访问。脚本最后重启 Explorer 强制刷新。
# 仅普通用户执行（管理员登录时重启 explorer 会干扰服务器管理）。
if (-not $IsAdmin) {
    Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
    Start-Process explorer.exe
}

Write-Host "========================================"
Write-Host "User $Username login environment initialized"
Write-Host "  Z: (public dataset, read-only) = \\127.0.0.1\StatsData
  W: (workspace, private)        = $UserWorkspace"
Write-Host "  Result output directory        = $UserPending"
Write-Host "========================================"
