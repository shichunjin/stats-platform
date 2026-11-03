# ============================================================
# lib/stats-config.ps1 —— 共享根（文件服务器）的统一解析与固化
# ============================================================
#
# 背景：改造前 W:/Z:/pending 一律指向 \\127.0.0.1——隐含假设「文件服务器与桌面是同一台机器」。
# 多 VM 后每台桌面 VM 上的 127.0.0.1 指向 VM 自己，必须改指中心文件服务器。
# 同类硬编码原本散布在 4 个脚本里（login.ps1 / enforce-output-location.ps1 /
# setup-workspace-drive.ps1 / setup-sftp-datadrive.ps1），逐个改常量迟早漏一个，
# 于是把「从哪儿取共享根」收敛到本文件，其余脚本只调函数。
#
# 解析顺序（高 → 低）：
#   1. 调用方显式传入 -FileServer
#   2. 环境变量 STATS_FILE_SERVER（模板固化为机器级；也便于临时排查）
#   3. 注册表 HKLM:\SOFTWARE\StatsPlatform 的 FileServer 值
#   4. 内置默认 \\127.0.0.1（单机一体部署形态，行为与改造前完全一致）
#
# 为什么保留 \\127.0.0.1 作默认：单机 RDS 形态仍在线上跑，没配任何东西的机器
# 必须照旧工作；多 VM 形态由模板阶段（prepare-desktop-template.ps1）写入 2/3 两层。
#
# 兼容：本文件被 dot-source（. .\lib\stats-config.ps1）使用，
# 因此**不要**在这里 Set-StrictMode——它会污染调用方作用域，
# 让登录脚本里合法的 $null 取值全部抛异常。
# ============================================================

$script:StatsConfigRegKey = 'HKLM:\SOFTWARE\StatsPlatform'
$script:StatsDefaultFileServer = '\\127.0.0.1'

function ConvertTo-StatsFileServerUnc {
    <#
    .SYNOPSIS
        把 'fileserver' / '\\fileserver' / '\\fileserver\' 统一成 '\\fileserver'。
    .DESCRIPTION
        只接受主机名或 IP：带共享名（\\host\workspace）会让调用方拼出
        \\host\workspace\workspace 这种双段路径，宁可当场报错也不要静默拼错。
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Value)

    $v = $Value.Trim()
    if ($v -eq '') { throw '文件服务器地址为空。' }

    $v = $v -replace '^[\\/]{2}', ''
    $v = $v.TrimEnd('\', '/')
    if ($v -eq '') { throw "文件服务器地址非法: '$Value'" }
    if ($v -match '[\\/]') {
        throw "文件服务器只接受主机名或 IP，不要带共享名或路径: '$Value'"
    }
    if ($v -match '\s') { throw "文件服务器地址不能包含空白字符: '$Value'" }
    return "\\$v"
}

function Resolve-StatsFileServer {
    <#
    .SYNOPSIS
        按「入参 → 环境变量 → 机器注册表 → 内置默认」解析共享根，返回 \\host 形式。
    .PARAMETER FileServer
        显式覆盖值；留空则按三级回落解析。
    #>
    [CmdletBinding()]
    param([string]$FileServer = '')

    if ($FileServer -and $FileServer.Trim() -ne '') {
        return ConvertTo-StatsFileServerUnc -Value $FileServer
    }

    $fromEnv = $env:STATS_FILE_SERVER
    if ($fromEnv -and $fromEnv.Trim() -ne '') {
        return ConvertTo-StatsFileServerUnc -Value $fromEnv
    }

    try {
        $reg = Get-ItemProperty -Path $script:StatsConfigRegKey -Name 'FileServer' -ErrorAction Stop
        if ($reg.FileServer) {
            return ConvertTo-StatsFileServerUnc -Value ([string]$reg.FileServer)
        }
    } catch {
        # 键不存在 / 无读取权限（极少数加固过的机器）→ 继续回落，不阻断登录
    }

    return $script:StatsDefaultFileServer
}

function Get-StatsFileServerOrigin {
    <#
    .SYNOPSIS
        返回当前生效的共享根来自哪一层（param/env/registry/default），仅用于诊断输出。
    #>
    [CmdletBinding()]
    param([string]$FileServer = '')

    if ($FileServer -and $FileServer.Trim() -ne '') { return 'param' }
    if ($env:STATS_FILE_SERVER -and $env:STATS_FILE_SERVER.Trim() -ne '') { return 'env' }
    try {
        $reg = Get-ItemProperty -Path $script:StatsConfigRegKey -Name 'FileServer' -ErrorAction Stop
        if ($reg.FileServer) { return 'registry' }
    } catch { }
    return 'default'
}

function Set-StatsFileServer {
    <#
    .SYNOPSIS
        把共享根固化到本机（写注册表，可选写机器级环境变量）。需要管理员权限。
    .DESCRIPTION
        模板构建时调用一次，克隆出来的每台 VM 都继承同一份配置；
        日常改文件服务器地址也用它，不必手工挖注册表。
    .PARAMETER MachineEnvironment
        同时写机器级环境变量 STATS_FILE_SERVER。环境变量优先级高于注册表，
        两者同源写入可避免「注册表改了但环境变量还指着老机器」的困惑。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$FileServer,
        [switch]$MachineEnvironment
    )

    $unc = ConvertTo-StatsFileServerUnc -Value $FileServer

    if (-not (Test-Path $script:StatsConfigRegKey)) {
        New-Item -Path $script:StatsConfigRegKey -Force | Out-Null
    }
    New-ItemProperty -Path $script:StatsConfigRegKey -Name 'FileServer' -Value $unc `
        -PropertyType String -Force | Out-Null

    if ($MachineEnvironment) {
        [Environment]::SetEnvironmentVariable('STATS_FILE_SERVER', $unc, 'Machine')
        # 同进程可见，便于后续步骤立刻验证
        $env:STATS_FILE_SERVER = $unc
    }

    return $unc
}

function Get-StatsFileServerReport {
    <#
    .SYNOPSIS
        一行文本说明「共享根 + 来源」，用于脚本启动时的可见性输出。
    #>
    [CmdletBinding()]
    param([string]$FileServer = '')

    $origin = Get-StatsFileServerOrigin -FileServer $FileServer
    $unc = Resolve-StatsFileServer -FileServer $FileServer
    return "$unc (来源: $origin)"
}
