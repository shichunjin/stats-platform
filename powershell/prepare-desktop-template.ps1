<#
.SYNOPSIS
    Windows 桌面模板固化脚本（多 VM 形态：在模板机上以管理员身份运行一次）

.DESCRIPTION
    把「一台能干活的桌面 VM」需要的东西一次性固化进镜像，克隆出来的每台 VM
    都继承同一份配置，不必逐台手工调。对应改造方案阶段 3（模板制作）里
    可以代码化的全部步骤：

      1. 共享根固化    —— 写 HKLM\SOFTWARE\StatsPlatform\FileServer +
                          机器级环境变量 STATS_FILE_SERVER，让 login.ps1 在
                          VM 上也能找到中心文件服务器（VM 的 127.0.0.1 是自己）
      2. 脚本部署      —— login.ps1 等脚本 + software-registry.json + lib\ 复制到
                          C:\stats-scripts，并锁成「普通用户只读、管理员可改」
      3. RDP 参数      —— 关 NLA + SecurityLayer=1 + 禁剪贴板/驱动器/打印机重定向
      4. 防火墙        —— 3389 仅放行 guacd 源，22 仅放行平台服务器源（可选）
      5. OpenSSH       —— DMS 用 SSH 建/改账号，模板必须预装并开机自启
      6. Guest Agent   —— 检查 qemu-guest-agent（缺失则 DMS 的 agent ping 永远失败）
      7. 版本清单      —— 生成 C:\stats-scripts\template-manifest.json，
                          其中的 login_script_ver / software_registry_ver
                          可直接填进 desktop_templates 表做批量核对

    本脚本不做的事（有意留手工）：
      - 不跑 sysprep：generalize 会重置 SID/管理员密码/网络，必须由运维
        在确认软件装好、脚本验证通过后自己执行（脚本末尾打印命令清单）。
      - 不装桌面软件：软件清单的唯一来源是 software-registry.json（运维维护）。
      - 不改 .env：GUAC_RDP_SECURITY 与「关 NLA」的配套关系在末尾提示。

.PARAMETER FileServer
    中心文件服务器主机名或 IP（共享根）。必填——模板里留空等于把 W: 指向 VM 自己。

.PARAMETER SourceDir
    仓库 powershell\ 目录（脚本来源）。默认本脚本所在目录。

.PARAMETER TargetDir
    VM 上的脚本落地目录。默认 C:\stats-scripts（与 login.ps1 的 $PSScriptRoot 假设一致）。

.PARAMETER GuacdSource
    guacd 的出网地址（IP/CIDR，可多个）。给了就把所有 3389 入站规则收紧到这些来源；
    不给则保持现状并告警——模板阶段盲目收紧会把运维自己的 RDP 也挡掉。

.PARAMETER PlatformSource
    平台服务器地址（IP/CIDR，可多个），用于把 22 端口入站收紧。不给则保持现状。

.PARAMETER SkipOpenSsh
    跳过 OpenSSH 安装。仅在镜像已自带 sshd 且不希望脚本改动时使用。

.PARAMETER TemplateName
    可选，写进清单用于人工核对（如 win2022-stats-v1）。

.PARAMETER SoftwareRegistryVersion
    可选，覆盖清单里的软件版本号（默认取 software-registry.json 的 SHA256 前 12 位）。

.EXAMPLE
    .\prepare-desktop-template.ps1 -FileServer fileserver

.EXAMPLE
    .\prepare-desktop-template.ps1 -FileServer 10.0.0.10 -GuacdSource 10.0.0.21,10.0.0.22 `
        -PlatformSource 10.0.0.5 -TemplateName win2022-stats-v1
#>
#Requires -RunAsAdministrator
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$FileServer,
    [string]$SourceDir = $PSScriptRoot,
    [string]$TargetDir = 'C:\stats-scripts',
    [string[]]$GuacdSource = @(),
    [string[]]$PlatformSource = @(),
    [switch]$SkipOpenSsh,
    [string]$TemplateName = '',
    [string]$SoftwareRegistryVersion = ''
)

$ErrorActionPreference = "Stop"

$StatsLibPath = Join-Path $SourceDir 'lib\stats-config.ps1'
if (-not (Test-Path $StatsLibPath)) {
    throw "缺少共享配置模块: $StatsLibPath（应在仓库 powershell\lib\ 下）"
}
. $StatsLibPath

function Write-Step([string]$Text) {
    Write-Host ""
    Write-Host "==> $Text" -ForegroundColor Yellow
}

function Get-ShortHash([string]$Path) {
    if (-not (Test-Path $Path)) { return '' }
    return (Get-FileHash -Path $Path -Algorithm SHA256).Hash.Substring(0, 12).ToLower()
}

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host " 桌面模板固化" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host " 主机: $env:COMPUTERNAME"
Write-Host " 来源: $SourceDir"
Write-Host " 落地: $TargetDir"

# ============================================================
# 1. 共享根固化
# ============================================================
Write-Step "[1/7] 固化共享根（注册表 + 机器级环境变量）"

$ResolvedServer = Set-StatsFileServer -FileServer $FileServer -MachineEnvironment
Write-Host "      HKLM\SOFTWARE\StatsPlatform\FileServer = $ResolvedServer" -ForegroundColor Green
Write-Host "      机器环境变量 STATS_FILE_SERVER        = $ResolvedServer" -ForegroundColor Green
Write-Host "      （login.ps1 解析顺序：-FileServer → 环境变量 → 注册表 → \\127.0.0.1）" -ForegroundColor DarkGray

# ============================================================
# 2. 部署脚本
# ============================================================
Write-Step "[2/7] 部署登录与落点脚本到 $TargetDir"

if (-not (Test-Path $TargetDir)) {
    New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null
}

$ScriptFiles = @('login.ps1', 'enforce-output-location.ps1', 'configure-rds.ps1', 'software-registry.json')
$Missing = @()
foreach ($f in $ScriptFiles) {
    $src = Join-Path $SourceDir $f
    if (-not (Test-Path $src)) {
        $Missing += $f
        continue
    }
    Copy-Item -Path $src -Destination (Join-Path $TargetDir $f) -Force
    Write-Host "      + $f" -ForegroundColor Green
}
if ($Missing.Count -gt 0) {
    throw "来源目录缺少文件: $($Missing -join ', ')（先 git pull 再跑）"
}

# lib\ 必须一起复制：login.ps1 找不到它只能降级到 \\127.0.0.1
$LibTarget = Join-Path $TargetDir 'lib'
if (-not (Test-Path $LibTarget)) {
    New-Item -ItemType Directory -Path $LibTarget -Force | Out-Null
}
Get-ChildItem -Path (Join-Path $SourceDir 'lib') -Filter '*.ps1' -File | ForEach-Object {
    Copy-Item -Path $_.FullName -Destination (Join-Path $LibTarget $_.Name) -Force
    Write-Host "      + lib\$($_.Name)" -ForegroundColor Green
}

# 普通用户只读：登录脚本以用户身份执行，若可写则等于把代码执行权交给用户
icacls $TargetDir /inheritance:r `
    /grant "*S-1-5-32-545:(OI)(CI)(RX)" "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "icacls 加固失败: $TargetDir" }
Write-Host "      ACL 已锁定（Users 只读，SYSTEM/Administrators 完全控制）" -ForegroundColor Green

# ============================================================
# 3. RDP 参数
# ============================================================
Write-Step "[3/7] RDP 参数（关 NLA + SecurityLayer=1 + 禁用各类重定向）"

$TsPolicy = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services'
if (-not (Test-Path $TsPolicy)) {
    New-Item -Path $TsPolicy -Force | Out-Null
}
Set-ItemProperty -Path $TsPolicy -Name 'fDenyTSConnections'  -Value 0 -Type DWord -Force
Set-ItemProperty -Path $TsPolicy -Name 'UserAuthentication'  -Value 0 -Type DWord -Force
Set-ItemProperty -Path $TsPolicy -Name 'SecurityLayer'       -Value 1 -Type DWord -Force
Set-ItemProperty -Path $TsPolicy -Name 'fDisableClip'        -Value 1 -Type DWord -Force
Set-ItemProperty -Path $TsPolicy -Name 'fDisableCdm'         -Value 1 -Type DWord -Force
Set-ItemProperty -Path $TsPolicy -Name 'fDisablePnp'         -Value 1 -Type DWord -Force
Set-ItemProperty -Path $TsPolicy -Name 'fSingleSessionPerUser' -Value 1 -Type DWord -Force
Write-Host "      UserAuthentication=0（关 NLA）、SecurityLayer=1（协商 TLS）" -ForegroundColor Green
Write-Host "      剪贴板/驱动器/打印机重定向已禁用" -ForegroundColor Green
Write-Host "      注意：关 NLA 后后端 .env 必须是 GUAC_RDP_SECURITY=tls（配合 GUAC_RDP_IGNORE_CERT=true），" -ForegroundColor Yellow
Write-Host "        否则 Guacamole 仍按 nla 发起协商，登录必然失败。" -ForegroundColor Yellow
Write-Host "      注意：以上注册表改动要重启 TermService 才生效（脚本末尾会安排自动重启）。" -ForegroundColor Yellow

# ============================================================
# 4. 防火墙
# ============================================================
Write-Step "[4/7] 防火墙收敛（3389 / 22 仅放行指定来源）"

$rdpRules = @(Get-NetFirewallRule -Direction Inbound -Enabled True -Action Allow -ErrorAction SilentlyContinue |
    Where-Object {
        $pf = $_ | Get-NetFirewallPortFilter -ErrorAction SilentlyContinue
        $pf -and $pf.Protocol -eq 'TCP' -and (@($pf.LocalPort) -contains '3389')
    })

if ($GuacdSource.Count -gt 0) {
    if ($rdpRules.Count -eq 0) {
        New-NetFirewallRule -DisplayName 'StatsPlatform RDP (guacd only)' -Direction Inbound `
            -Protocol TCP -LocalPort 3389 -Action Allow -RemoteAddress $GuacdSource | Out-Null
        Write-Host "      已新建 3389 入站规则，来源限定为: $($GuacdSource -join ', ')" -ForegroundColor Green
    } else {
        foreach ($r in $rdpRules) {
            Set-NetFirewallRule -Name $r.Name -RemoteAddress $GuacdSource | Out-Null
        }
        Write-Host "      已把 $($rdpRules.Count) 条 3389 入站规则的来源收紧为: $($GuacdSource -join ', ')" -ForegroundColor Green
    }
} else {
    Write-Host "      未指定 -GuacdSource，保持现有 3389 规则不变（模板克隆后再收紧亦可）" -ForegroundColor Yellow
}

# ============================================================
# 5. OpenSSH Server（DMS 建账号/改密码的通道）
# ============================================================
Write-Step "[5/7] OpenSSH Server（DMS 账号同步通道）"

$OpenSshOk = $false
if ($SkipOpenSsh) {
    $OpenSshOk = $null -ne (Get-Service -Name 'sshd' -ErrorAction SilentlyContinue)
    Write-Host "      跳过安装（-SkipOpenSsh）；sshd 存在: $OpenSshOk" -ForegroundColor Yellow
} else {
    $cap = Get-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0'
    if (-not $cap) {
        Write-Warning "本机镜像不含 OpenSSH.Server 能力（Get-WindowsCapability 无返回），请手工安装后重跑"
    } elseif ($cap.State -ne 'Installed') {
        Add-WindowsCapability -Online -Name $cap.Name | Out-Null
        Write-Host "      OpenSSH Server 安装完成" -ForegroundColor Green
    } else {
        Write-Host "      OpenSSH Server 已安装，跳过" -ForegroundColor Green
    }
    $sshd = Get-Service -Name 'sshd' -ErrorAction SilentlyContinue
    if (-not $sshd) {
        Write-Warning "sshd 服务未找到，DMS 将无法在 VM 上建账号"
    } else {
        Set-Service -Name sshd -StartupType Automatic
        if ($sshd.Status -ne 'Running') { Start-Service sshd }
        $OpenSshOk = $true
        Write-Host "      sshd 已设为自启并运行" -ForegroundColor Green
    }
}

if ($PlatformSource.Count -gt 0) {
    $sshRules = @(Get-NetFirewallRule -Direction Inbound -Enabled True -Action Allow -ErrorAction SilentlyContinue |
        Where-Object {
            $pf = $_ | Get-NetFirewallPortFilter -ErrorAction SilentlyContinue
            $pf -and $pf.Protocol -eq 'TCP' -and (@($pf.LocalPort) -contains '22')
        })
    if ($sshRules.Count -eq 0) {
        New-NetFirewallRule -DisplayName 'StatsPlatform SSH (platform only)' -Direction Inbound `
            -Protocol TCP -LocalPort 22 -Action Allow -RemoteAddress $PlatformSource | Out-Null
        Write-Host "      已新建 22 入站规则，来源限定为: $($PlatformSource -join ', ')" -ForegroundColor Green
    } else {
        foreach ($r in $sshRules) {
            Set-NetFirewallRule -Name $r.Name -RemoteAddress $PlatformSource | Out-Null
        }
        Write-Host "      已把 $($sshRules.Count) 条 22 入站规则的来源收紧为: $($PlatformSource -join ', ')" -ForegroundColor Green
    }
} else {
    Write-Host "      未指定 -PlatformSource，22 端口来源保持现状" -ForegroundColor Yellow
}

# ============================================================
# 6. QEMU Guest Agent
# ============================================================
Write-Step "[6/7] QEMU Guest Agent（DMS 等开机完成的依据）"

$guestAgent = @(Get-Service -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'qemu' })
if ($guestAgent.Count -gt 0) {
    $guestAgent | ForEach-Object {
        if ($_.StartType -ne 'Automatic') { Set-Service -Name $_.Name -StartupType Automatic -ErrorAction SilentlyContinue }
        if ($_.Status -ne 'Running') { Start-Service -Name $_.Name -ErrorAction SilentlyContinue }
        Write-Host "      $($_.Name): $($_.Status) / $($_.StartType)" -ForegroundColor Green
    }
    $AgentOk = $true
} else {
    Write-Warning "未检测到 QEMU Guest Agent：DMS 的 waitAgent/probe 会一直超时，请先在模板里装 virtio-win 的 guest-agent"
    $AgentOk = $false
}

# ============================================================
# 6.5 安排 TermService 重启（RDP 参数生效的前提）
# ============================================================
# UserAuthentication/SecurityLayer 等注册表值只在 TermService 重启后生效。
# 脚本多半经 RDP 运行，直接 Restart-Service 会立刻掐断本会话（后续输出全部丢失），
# 故注册一个 60 秒后执行的一次性计划任务：看完输出、记下提示，再等它自动断线重连。
$TermServiceRestart = 'pending'
Write-Host ""
Write-Host " [6.5] 注册计划任务：60 秒后重启 TermService（RDP 参数生效，本会话将断开）" -ForegroundColor Yellow
$restartTime = (Get-Date).AddSeconds(60).ToString('HH:mm:ss')
$restartAction = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Restart-Service TermService -Force"'
schtasks.exe /Create /TN 'StatsTemplate-RestartTermService' /TR $restartAction `
    /SC ONCE /ST $restartTime /F /RL HIGHEST | Out-Null
if ($LASTEXITCODE -eq 0) {
    Write-Host "      已安排 $restartTime 重启 TermService，届时 RDP 会断开，稍后重连即可。" -ForegroundColor Green
    Write-Host "      （重连后可删除任务：schtasks /Delete /TN StatsTemplate-RestartTermService /F）" -ForegroundColor DarkGray
    $TermServiceRestart = 'scheduled'
} else {
    Write-Warning "计划任务注册失败，请手动执行：Restart-Service TermService -Force（或重启机器）"
    $TermServiceRestart = 'manual_required'
}

# ============================================================
# 7. 版本清单
# ============================================================
Write-Step "[7/7] 生成版本清单"

$LoginVer = Get-ShortHash (Join-Path $TargetDir 'login.ps1')
$RegistryVer = $SoftwareRegistryVersion
if (-not $RegistryVer) {
    $RegistryVer = Get-ShortHash (Join-Path $TargetDir 'software-registry.json')
}

$checks = [ordered]@{
    file_server_registry = $ResolvedServer
    openssh              = [bool]$OpenSshOk
    qemu_guest_agent     = $AgentOk
    nla_disabled         = $true
    term_service_restart = $TermServiceRestart
    rdp_firewall_scoped  = ($GuacdSource.Count -gt 0)
    ssh_firewall_scoped  = ($PlatformSource.Count -gt 0)
}

$manifest = [ordered]@{
    prepared_at            = (Get-Date).ToUniversalTime().ToString('o')
    hostname               = $env:COMPUTERNAME
    template_name          = $TemplateName
    file_server            = $ResolvedServer
    login_script_ver       = $LoginVer
    software_registry_ver  = $RegistryVer
    checks                 = $checks
}

$ManifestPath = Join-Path $TargetDir 'template-manifest.json'
$json = $manifest | ConvertTo-Json -Depth 5
# 写成无 BOM UTF-8：BOM 会让别的工具（含 JS 的 JSON.parse）解析失败
[IO.File]::WriteAllText($ManifestPath, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "      清单: $ManifestPath" -ForegroundColor Green
Write-Host "      login_script_ver      = $LoginVer   ← 填 desktop_templates.login_script_ver" -ForegroundColor Green
Write-Host "      software_registry_ver = $RegistryVer  ← 填 desktop_templates.software_registry_ver" -ForegroundColor Green

# ============================================================
# 收尾：验证清单与 sysprep 提示
# ============================================================
Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host " 完成。下一步（按顺序，全部通过再转模板）" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host " 1. 验证共享根可达： Test-Path '$ResolvedServer\workspace'"
Write-Host " 2. 用一个测试账号登录一次（走 console 或 RDP），确认："
Write-Host "      - W: 已映射、Z: 盘可读、$ResolvedServer\pending\<用户名> 快捷方式可见"
Write-Host "      - 软件从桌面快捷方式启动后，另存为默认落在 W:"
Write-Host " 3. 后端 .env 对齐： GUAC_RDP_SECURITY=tls + GUAC_RDP_IGNORE_CERT=true"
Write-Host "    （TermService 重启后 RDP 参数才生效；若刚才没断线，手动执行：" -ForegroundColor Yellow
Write-Host "      Restart-Service TermService -Force 或重启机器）" -ForegroundColor Yellow
Write-Host " 4. 关机后转模板（Proxmox：右键 Convert to template），命令参考："
Write-Host "      qm template <vmid>"
Write-Host "    如需重新封装 SID（推荐首次制作时做一次）："
Write-Host "      C:\Windows\System32\Sysprep\sysprep.exe /generalize /oobe /shutdown"
Write-Host "    注意：sysprep 会重置本机管理员密码与网络配置；ipconfig0 由 DMS 克隆后下发，"
Write-Host "      不要在模板里写死静态 IP。"
Write-Host " 5. 把 desktop_templates 行的 status 置 active、is_default 置 true，再让 DMS 克隆。"
Write-Host ""

if (-not $AgentOk) {
    Write-Host " 未通过：QEMU Guest Agent 缺失（DMS 会卡在 provisioning）" -ForegroundColor Red
    exit 2
}
if (-not $OpenSshOk) {
    Write-Host " 未通过：OpenSSH 不可用（DMS 无法建账号）" -ForegroundColor Red
    exit 3
}
exit 0
