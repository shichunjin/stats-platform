<#
.SYNOPSIS
    统计软件托管平台 - Windows 登录脚本
.DESCRIPTION
    根据 AD / 平台 token 获取用户信息，映射 Z:(只读原始数据) 和 W:(可写工作区)，
    设置软件环境变量，生成桌面快捷方式，配置文件夹权限。
.NOTES
    在 Windows Server 2022 上以用户登录脚本方式运行（通过组策略或 RDS Session 启动脚本）。
#>

param(
    [Parameter(Mandatory=$true)][string]$Username,
    [Parameter(Mandatory=$true)][int]$UserId,
    [Parameter(Mandatory=$true)][int]$DeptId,
    [Parameter(Mandatory=$true)][string]$Software,
    [string]$GuacId = ""
)

$ErrorActionPreference = "Stop"

# ============================================================
# 路径常量
# ============================================================
$FileServer = "\\fileserver"
$DataRoot     = "$FileServer\data"
$WorkspaceRoot = "$FileServer\workspace"
$PendingRoot  = "$FileServer\pending"

$ZDrive = "Z:"
$WDrive = "W:"

# 用户工作区
$UserWorkspace = "$WorkspaceRoot\$UserId"
# 待审查目录
$UserPending = "$PendingRoot\$UserId"
# 原始数据目录（按 dept_id 映射，实际可从平台 API 获取 scope_code）
$UserScopeDir = "$DataRoot\dept_$DeptId"

# ============================================================
# 1. 创建用户工作区目录
# ============================================================
if (-not (Test-Path $UserWorkspace)) {
    New-Item -Path $UserWorkspace -ItemType Directory -Force | Out-Null
}
if (-not (Test-Path $UserPending)) {
    New-Item -Path $UserPending -ItemType Directory -Force | Out-Null
}

# ============================================================
# 2. 映射网络驱动器
# ============================================================
# Z: → 原始数据 (只读)
if (Test-Path $ZDrive) { net use $ZDrive /delete /y }
net use $ZDrive $UserScopeDir /persistent:no

# W: → 用户工作区 (可写)
if (Test-Path $WDrive) { net use $WDrive /delete /y }
net use $WDrive $UserWorkspace /persistent:no

# ============================================================
# 3. 设置文件夹权限 (Z: 只读, W: 可写)
# ============================================================
# Z: 盘 - 当前用户只读
$aclZ = Get-Acl $UserScopeDir
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    $env:USERNAME, "ReadAndExecute", "ContainerInherit,ObjectInherit", "None", "Allow"
)
$aclZ.SetAccessRule($rule)
Set-Acl -Path $UserScopeDir -AclObject $aclZ

# W: 盘 - 当前用户完全控制
$aclW = Get-Acl $UserWorkspace
$ruleW = New-Object System.Security.AccessControl.FileSystemAccessRule(
    $env:USERNAME, "FullControl", "ContainerInherit,ObjectInherit", "None", "Allow"
)
$aclW.SetAccessRule($ruleW)
Set-Acl -Path $UserWorkspace -AclObject $aclW

# ============================================================
# 4. 写注册表/环境变量：软件工作目录
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

# 通用：结果输出目录
[Environment]::SetEnvironmentVariable("RESULTS_DIR", $UserPending, "User")
[Environment]::SetEnvironmentVariable("USER_ID", $UserId, "User")

# ============================================================
# 5. 生成桌面快捷方式
# ============================================================
$Desktop = [Environment]::GetFolderPath("Desktop")
$Shell = New-Object -ComObject WScript.Shell

$SoftwareConfigs = @{
    rstudio = @{
        Path = "C:\Program Files\RStudio\bin\rstudio.exe"
        Name = "RStudio"
        Args = ""
    }
    mplus = @{
        Path = "C:\Program Files\Mplus\mplus.exe"
        Name = "Mplus Editor"
        Args = ""
    }
    stata = @{
        Path = "C:\Program Files\Stata18\StataSE-64.exe"
        Name = "Stata SE 18"
        Args = ""
    }
}

# 为所有软件创建快捷方式
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

# ============================================================
# 6. 禁用远程桌面剪贴板和本地驱动器映射（通过注册表）
# ============================================================
# 禁用剪贴板重定向 (仅禁用从远程到本地的剪贴板)
$TSConfigPath = "HKLM:\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services"
if (-not (Test-Path $TSConfigPath)) {
    New-Item -Path $TSConfigPath -Force | Out-Null
}
Set-ItemProperty -Path $TSConfigPath -Name "fDisableClip" -Value 1 -Type DWord
Set-ItemProperty -Path $TSConfigPath -Name "fDisableCdm" -Value 1 -Type DWord

# ============================================================
# 7. 启动指定软件
# ============================================================
if ($Software -and $SoftwareConfigs.ContainsKey($Software.ToLower())) {
    $cfg = $SoftwareConfigs[$Software.ToLower()]
    if (Test-Path $cfg.Path) {
        Start-Process -FilePath $cfg.Path -WorkingDirectory $WDrive
        Write-Host "已启动 $Software: $($cfg.Path)"
    } else {
        Write-Warning "软件未安装: $($cfg.Path)"
    }
}

Write-Host "========================================"
Write-Host "用户 $Username 登录环境初始化完成"
Write-Host "  Z: (原始数据-只读) = $UserScopeDir"
Write-Host "  W: (工作区-可写)   = $UserWorkspace"
Write-Host "  结果输出目录       = $UserPending"
Write-Host "========================================"
