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
$FileServer = "\\127.0.0.1"
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
# Z: is mapped by the public startup script (map-z-drive.cmd -> \\127.0.0.1\StatsData,
# the shared public dataset). Do NOT touch Z: here to avoid fighting that mapping.

# W: -> user workspace (writable, PRIVATE per user)
if (Test-Path $WDrive) { net use $WDrive /delete /y }
net use $WDrive $UserWorkspace /persistent:no

# ============================================================
# 3. Set folder permissions (W: strictly private per user)
# ============================================================
# Strip inherited permissions so other users can never read this
# user's workspace, then grant only: current user, SYSTEM, Administrators.
icacls $UserWorkspace /inheritance:r | Out-Null
icacls $UserWorkspace /grant "$($env:USERNAME):(OI)(CI)F" "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F" | Out-Null

# Pending (results output) directory: same strict isolation
icacls $UserPending /inheritance:r | Out-Null
icacls $UserPending /grant "$($env:USERNAME):(OI)(CI)F" "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F" | Out-Null

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
        Write-Host "Launched ${Software}: $($cfg.Path)"
    } else {
        Write-Warning "Software not installed: $($cfg.Path)"
    }
}

Write-Host "========================================"
Write-Host "User $Username login environment initialized"
Write-Host "  Z: (public dataset, read-only) = \\127.0.0.1\StatsData"
Write-Host "  W: (workspace, writable) = $UserWorkspace"
Write-Host "  Result output directory = $UserPending"
Write-Host "========================================"
