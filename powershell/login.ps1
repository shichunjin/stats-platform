<#
.SYNOPSIS
    Stats platform - Windows user login script
.DESCRIPTION
    Maps Z: (read-only raw data) and W: (writable workspace) based on user info,
    sets software environment variables, creates desktop shortcuts,
    and configures folder permissions.
.NOTES
    Runs as a user login script on Windows Server 2022 (via RDS session startup script).
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
# Path constants
# ============================================================
$FileServer = "\\fileserver"
$DataRoot     = "$FileServer\data"
$WorkspaceRoot = "$FileServer\workspace"
$PendingRoot  = "$FileServer\pending"

$ZDrive = "Z:"
$WDrive = "W:"

# User workspace
$UserWorkspace = "$WorkspaceRoot\$UserId"
# Pending review directory
$UserPending = "$PendingRoot\$UserId"
# Raw data directory (mapped by dept_id; scope_code can be fetched from platform API)
$UserScopeDir = "$DataRoot\dept_$DeptId"

# ============================================================
# 1. Create user workspace directories
# ============================================================
if (-not (Test-Path $UserWorkspace)) {
    New-Item -Path $UserWorkspace -ItemType Directory -Force | Out-Null
}
if (-not (Test-Path $UserPending)) {
    New-Item -Path $UserPending -ItemType Directory -Force | Out-Null
}

# ============================================================
# 2. Map network drives
# ============================================================
# Z: -> raw data (read-only)
if (Test-Path $ZDrive) { net use $ZDrive /delete /y }
net use $ZDrive $UserScopeDir /persistent:no

# W: -> user workspace (writable)
if (Test-Path $WDrive) { net use $WDrive /delete /y }
net use $WDrive $UserWorkspace /persistent:no

# ============================================================
# 3. Set folder permissions (Z: read-only, W: writable)
# ============================================================
# Z: drive - current user read-only
$aclZ = Get-Acl $UserScopeDir
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    $env:USERNAME, "ReadAndExecute", "ContainerInherit,ObjectInherit", "None", "Allow"
)
$aclZ.SetAccessRule($rule)
Set-Acl -Path $UserScopeDir -AclObject $aclZ

# W: drive - current user full control
$aclW = Get-Acl $UserWorkspace
$ruleW = New-Object System.Security.AccessControl.FileSystemAccessRule(
    $env:USERNAME, "FullControl", "ContainerInherit,ObjectInherit", "None", "Allow"
)
$aclW.SetAccessRule($ruleW)
Set-Acl -Path $UserWorkspace -AclObject $aclW

# ============================================================
# 4. Write registry/environment variables: software working directories
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
[Environment]::SetEnvironmentVariable("USER_ID", $UserId, "User")

# ============================================================
# 5. Create desktop shortcuts
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

# ============================================================
# 6. Disable RDP clipboard and local drive redirection (registry)
# ============================================================
# Disable clipboard redirection (remote to local)
$TSConfigPath = "HKLM:\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services"
if (-not (Test-Path $TSConfigPath)) {
    New-Item -Path $TSConfigPath -Force | Out-Null
}
Set-ItemProperty -Path $TSConfigPath -Name "fDisableClip" -Value 1 -Type DWord
Set-ItemProperty -Path $TSConfigPath -Name "fDisableCdm" -Value 1 -Type DWord

# ============================================================
# 7. Launch the specified software
# ============================================================
if ($Software -and $SoftwareConfigs.ContainsKey($Software.ToLower())) {
    $cfg = $SoftwareConfigs[$Software.ToLower()]
    if (Test-Path $cfg.Path) {
        Start-Process -FilePath $cfg.Path -WorkingDirectory $WDrive
        Write-Host "Launched $Software: $($cfg.Path)"
    } else {
        Write-Warning "Software not installed: $($cfg.Path)"
    }
}

Write-Host "========================================"
Write-Host "User $Username login environment initialized"
Write-Host "  Z: (raw data, read-only) = $UserScopeDir"
Write-Host "  W: (workspace, writable) = $UserWorkspace"
Write-Host "  Result output directory = $UserPending"
Write-Host "========================================"
