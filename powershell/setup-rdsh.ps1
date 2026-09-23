# ============================================================
# setup-rdsh.ps1 — Single-host RDS Session Host deployment (workgroup / no AD)
# ============================================================
#
# Scenario: no Active Directory domain, single Windows Server, accessed by IP.
# Architecture: Apache Guacamole -> RDP -> this server (Session Host role only).
#
# This script does three things:
#   1. Install Remote Desktop Session Host role (multi-user RDP support)
#   2. Configure licensing mode (PerUser). Without a license server,
#      a 120-day grace period applies.
#   3. Create a local account for each stats-software user and add it to
#      the "Remote Desktop Users" group.
#
# IMPORTANT:
#   - Do NOT install RDS-Connection-Broker / RDS-Licensing roles; they require AD.
#   - Do NOT run New-RDSessionDeployment / Set-RDLicenseConfiguration;
#     they depend on Connection Broker and always fail without a domain.
#   - For long-term production, purchase RDS CALs and activate a license server.
#
# Usage examples:
#   # 1) Bulk create users from CSV (CSV columns: username,password)
#   .\setup-rdsh.ps1 -UserCsv .\users.csv
#
#   # 2) Create a single user (password prompted at runtime)
#   .\setup-rdsh.ps1 -NewUser "user1"
#
#   # 3) Install role and configure licensing only (no user creation)
#   .\setup-rdsh.ps1
# ============================================================

[CmdletBinding()]
param(
    # Optional: bulk-create users (CSV file with username,password columns)
    [string]$UserCsv,

    # Optional: create a single user (password prompted at runtime)
    [string]$NewUser,

    # Skip reboot prompt (default: prompt if role installation requires reboot)
    [switch]$SkipRestart
)

$ErrorActionPreference = "Stop"

# ============================================================
# 0. Privilege check: must run as Administrator
# ============================================================
function Test-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Admin)) {
    Write-Error "Please run this script as Administrator."
    exit 1
}

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host " Stats Platform - RDS Session Host setup (workgroup)" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""

# ============================================================
# 1. Install Remote Desktop Session Host role
# ============================================================
Write-Host "[1/3] Installing Remote Desktop Session Host role..." -ForegroundColor Yellow

$feature = Get-WindowsFeature -Name RDS-RD-Server
if ($feature.Installed) {
    Write-Host "      RDS-RD-Server is already installed, skipping." -ForegroundColor Green
} else {
    $result = Install-WindowsFeature RDS-RD-Server -IncludeManagementTools
    if ($result.RestartNeeded -eq "Yes") {
        Write-Host "      Role installed. A reboot is required." -ForegroundColor Yellow
        if (-not $SkipRestart) {
            Write-Host "      Reboot now? (y/n, default n)" -ForegroundColor Yellow
            $answer = Read-Host
            if ($answer -eq "y") {
                Restart-Computer -Force
                exit 0
            }
        } else {
            Write-Host "      Reboot skipped (-SkipRestart). Please reboot manually later." -ForegroundColor Yellow
        }
    } else {
        Write-Host "      RDS-RD-Server installed successfully." -ForegroundColor Green
    }
}

# ============================================================
# 2. Configure licensing mode (PerUser)
# ============================================================
Write-Host "[2/3] Configuring licensing mode (PerUser)..." -ForegroundColor Yellow

$licRegPath = "HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server\RCM\Licensing Core"
if (-not (Test-Path $licRegPath)) {
    New-Item -Path $licRegPath -Force | Out-Null
}

# LicensingMode: 2 = PerDevice, 4 = PerUser
Set-ItemProperty -Path $licRegPath -Name "LicensingMode" -Value 4 -Type DWord -Force
Write-Host "      Licensing mode set to PerUser (4)." -ForegroundColor Green

# License server: when unset, the 120-day grace period applies.
# If you already have a license server, uncomment below and fill in its IP.
# $licServerPath = "HKLM:\SYSTEM\CurrentControlSet\Services\TermService\Parameters\LicenseServers"
# New-Item -Path $licServerPath -Force | Out-Null
# New-ItemProperty -Path $licServerPath -Name "SpecifiedLicenseServers" `
#     -Value @("YOUR_LICENSE_SERVER_IP") -PropertyType MultiString -Force
# Write-Host "      License server specified."

Write-Host "      No license server set; the 120-day grace period applies (purchase RDS CALs for production)." -ForegroundColor Yellow

# ============================================================
# 3. Create local users
# ============================================================
Write-Host "[3/3] Creating local users and granting access..." -ForegroundColor Yellow

# Collect users to create: @{ username = password }
$usersToCreate = @{}

if ($UserCsv) {
    if (-not (Test-Path $UserCsv)) {
        Write-Error "Cannot find user CSV file: $UserCsv"
        exit 1
    }
    $rows = Import-Csv -Path $UserCsv
    foreach ($row in $rows) {
        if ($row.username -and $row.password) {
            $usersToCreate[$row.username] = $row.password
        }
    }
    Write-Host "      Read $($usersToCreate.Count) user(s) from CSV." -ForegroundColor Green
}

if ($NewUser) {
    $secure = Read-Host "Enter password for user '$NewUser'" -AsSecureString
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    )
    $usersToCreate[$NewUser] = $plain
}

foreach ($username in $usersToCreate.Keys) {
    $password = $usersToCreate[$username]

    $existing = Get-LocalUser -Name $username -ErrorAction SilentlyContinue
    if ($existing) {
        Write-Host "      User '$username' already exists, skipping creation." -ForegroundColor Green
    } else {
        $securePwd = ConvertTo-SecureString $password -AsPlainText -Force
        New-LocalUser -Name $username -Password $securePwd -PasswordNeverExpires -Description "Stats Platform user" | Out-Null
        Write-Host "      Created local user '$username'." -ForegroundColor Green
    }

    $rdUsers = Get-LocalGroupMember -Group "Remote Desktop Users" -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like "*\$username" }
    if (-not $rdUsers) {
        Add-LocalGroupMember -Group "Remote Desktop Users" -Member $username
        Write-Host "      Added '$username' to the Remote Desktop Users group." -ForegroundColor Green
    } else {
        Write-Host "      '$username' is already in the Remote Desktop Users group." -ForegroundColor Green
    }
}

if ($usersToCreate.Count -eq 0) {
    Write-Host "      No user specified (use -UserCsv or -NewUser)." -ForegroundColor Yellow
    Write-Host "      Manual user creation commands:" -ForegroundColor Yellow
    Write-Host "        New-LocalUser -Name 'user1' -Password (Read-Host -AsSecureString) -PasswordNeverExpires"
    Write-Host "        Add-LocalGroupMember -Group 'Remote Desktop Users' -Member 'user1'"
}

# ============================================================
# Done
# ============================================================
Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host " Deployment complete." -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host " Next steps:"
Write-Host "   1. Run security config: .\configure-rds.ps1"
Write-Host "   2. Restart TermService to apply licensing: Restart-Service TermService -Force"
Write-Host "   3. In guacamole/user-mapping.xml, set hostname to this server's IP"
Write-Host "   4. Install stats software (RStudio / Mplus / StataSE 18)"
Write-Host ""
