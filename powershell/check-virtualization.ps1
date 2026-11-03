<#
.SYNOPSIS
  探测本机能否作为虚拟化宿主（Hyper-V），并给出资源账。

.DESCRIPTION
  用途：决定「这台云主机能不能承担一人一 VM 的宿主角色」。

  为什么需要先探测：阿里云的普通 ECS 实例**默认不向 Guest 暴露 VT-x/AMD-V**，
  Hyper-V 角色可以装上（Windows Server 自带），但一开机就报
  「虚拟机监控程序未运行」，等于白装。而这一步只有装完才暴露，代价是重启 + 回滚。

  本脚本把判定依据一次打全，不装任何东西、不改任何配置，纯只读：
    1. 机型身份（是否在阿里云/KVM 下）
    2. CPU 是否暴露虚拟化扩展（VMMonitorModeExtensions 是关键）
    3. Hyper-V 角色当前状态
    4. 资源账（vCPU / 内存 / 各盘剩余 —— 80 GiB 系统盘通常放不下模板 + VM 磁盘）
    5. 结论（可做宿主 / 不可做宿主 / 判定不完整）

  用法（以管理员身份运行，非管理员也能跑，只是第 3 段读不到）：
    .\check-virtualization.ps1

  退出码：
    0 = 可做虚拟化宿主
    2 = 不可做宿主（缺硬件虚拟化能力）
    3 = 判定不完整（需要人工看输出）

.NOTES
  只读脚本：不安装角色、不重启、不改注册表。
#>

$ErrorActionPreference = 'Stop'

function Write-Section {
    param([string]$Title)
    Write-Host ''
    Write-Host "===== $Title =====" -ForegroundColor Cyan
}

function Format-Gb {
    param([double]$Bytes)
    return [math]::Round($Bytes / 1GB, 1)
}

# ============================================================
# 1. 机型身份：判断是否运行在云厂商的 hypervisor 之下
# ============================================================
Write-Section '1. 机型身份'

$cs = $null
try { $cs = Get-CimInstance -ClassName Win32_ComputerSystem } catch { }
$bios = $null
try { $bios = Get-CimInstance -ClassName Win32_BIOS } catch { }

$manufacturer = if ($cs) { [string]$cs.Manufacturer } else { 'unknown' }
$model = if ($cs) { [string]$cs.Model } else { 'unknown' }

Write-Host ("  Manufacturer : {0}" -f $manufacturer)
Write-Host ("  Model        : {0}" -f $model)
Write-Host ("  OS           : {0}" -f ([string](Get-CimInstance Win32_OperatingSystem).Caption))

# 云上实例的 Model 通常是 "Alibaba Cloud ECS Instance" / "KVM" / "Virtual Machine"
$isVirtualized = $false
if ($manufacturer -match 'Alibaba|Xen|QEMU|KVM|VMware|Microsoft Corporation' -or $model -match 'Virtual|KVM|ECS|VMware') {
    $isVirtualized = $true
}
if ($isVirtualized) {
    Write-Host '  → 本机本身是一台虚拟机（云主机），要再开 VM 就必须支持「嵌套虚拟化」。' -ForegroundColor Yellow
} else {
    Write-Host '  → 未识别出虚拟化特征，可能是物理机。' -ForegroundColor Green
}

# ============================================================
# 2. CPU 虚拟化能力：这三项决定 Hyper-V 能不能真正跑起来
# ============================================================
Write-Section '2. CPU 与虚拟化能力'

$cpu = Get-CimInstance -ClassName Win32_Processor | Select-Object -First 1
Write-Host ("  CPU          : {0}" -f ([string]$cpu.Name).Trim())
Write-Host ("  逻辑处理器   : {0}" -f $cpu.NumberOfLogicalProcessors)

# VMMonitorModeExtensions = VT-x/AMD-V 对当前 Guest 可见（嵌套虚拟化的必要条件）
# SecondLevelAddressTranslationExtensions = EPT/NPT（Win2022 的 VM 需要，通常也必须为 True）
$vmm = [bool]$cpu.VMMonitorModeExtensions
$slat = [bool]$cpu.SecondLevelAddressTranslationExtensions
$fwEnabled = [bool]$cpu.VirtualizationFirmwareEnabled

Write-Host ("  VMMonitorModeExtensions (VT-x/AMD-V 可见) : {0}" -f $vmm) -ForegroundColor $(if ($vmm) { 'Green' } else { 'Red' })
Write-Host ("  SLAT (EPT/NPT)                            : {0}" -f $slat) -ForegroundColor $(if ($slat) { 'Green' } else { 'Red' })
Write-Host ("  VirtualizationFirmwareEnabled             : {0}" -f $fwEnabled)

# systeminfo 的 Hyper-V 段：若显示「已检测到虚拟机监控程序」，说明本机已在 hypervisor 下
$sysInfoHyperV = ''
try {
    $raw = & systeminfo.exe 2>$null
    $start = ($raw | Select-String -Pattern 'Hyper-V' | Select-Object -First 1)
    if ($start) {
        $idx = [array]::IndexOf($raw, $start.Line)
        $sysInfoHyperV = ($raw[$idx..([math]::Min($idx + 4, $raw.Count - 1))] -join ' ')
    }
} catch { }
if ($sysInfoHyperV) {
    Write-Host ("  systeminfo   : {0}" -f $sysInfoHyperV.Trim())
}

# ============================================================
# 3. Hyper-V 角色状态（需要管理员；非管理员只提示）
# ============================================================
Write-Section '3. Hyper-V 角色状态'

$isAdmin = $false
try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    $isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
} catch { }

$hyperVState = 'Unknown'
if ($isAdmin) {
    try {
        $feature = Get-WindowsOptionalFeature -Online -FeatureName 'Microsoft-Hyper-V-All' -ErrorAction Stop
        $hyperVState = [string]$feature.State
    } catch {
        $hyperVState = "ReadFailed: $($_.Exception.Message)"
    }
    Write-Host ("  Microsoft-Hyper-V-All : {0}" -f $hyperVState)
    try {
        $svc = Get-Service -Name 'vmms' -ErrorAction Stop
        Write-Host ("  vmms 服务             : {0} / {1}" -f $svc.Status, $svc.StartType)
    } catch {
        Write-Host '  vmms 服务             : 未安装' -ForegroundColor DarkGray
    }
} else {
    Write-Host '  当前不是管理员，跳过（如需完整判定请以管理员身份重跑）' -ForegroundColor Yellow
}

# ============================================================
# 4. 资源账：能开几台
# ============================================================
Write-Section '4. 资源账'

$totalMemGb = if ($cs) { [math]::Round($cs.TotalPhysicalMemory / 1GB, 1) } else { 0 }
$vcpu = if ($cpu) { [int]$cpu.NumberOfLogicalProcessors } else { 0 }
Write-Host ("  总内存       : {0} GiB" -f $totalMemGb)
Write-Host ("  逻辑 CPU     : {0}" -f $vcpu)
Write-Host ''
Write-Host '  磁盘：'
$volumes = @()
try {
    $volumes = Get-Volume | Where-Object { $_.DriveLetter } | Sort-Object DriveLetter
} catch { }
foreach ($v in $volumes) {
    Write-Host ("    {0}: 总 {1} GiB / 可用 {2} GiB" -f $v.DriveLetter, (Format-Gb $v.Size), (Format-Gb $v.SizeRemaining))
}

# 宿主预留：Windows 自己 + 服务约 4 GiB 内存、1 vCPU
$reservedMemGb = 4
$reservedVcpu = 1
$usableMemGb = [math]::Max(0, $totalMemGb - $reservedMemGb)
$usableVcpu = [math]::Max(0, $vcpu - $reservedVcpu)

Write-Host ''
Write-Host ("  扣除宿主预留（{0} GiB / {1} vCPU）后可分配：{2} GiB / {3} vCPU" -f `
    $reservedMemGb, $reservedVcpu, $usableMemGb, $usableVcpu)

# 用「内存」和「CPU」双约束估算，取小值
function Get-VmCount {
    param([int]$VmMemGb, [int]$VmVcpu)
    $byMem = if ($VmMemGb -gt 0) { [math]::Floor($usableMemGb / $VmMemGb) } else { 0 }
    $byCpu = if ($VmVcpu -gt 0) { [math]::Floor($usableVcpu / $VmVcpu) } else { 0 }
    return [math]::Min($byMem, $byCpu)
}

$small = Get-VmCount -VmMemGb 4 -VmVcpu 2
$large = Get-VmCount -VmMemGb 16 -VmVcpu 4
Write-Host ("  参考：2C4G 的测试 VM 最多 {0} 台；4C16G 的桌面 VM 最多 {1} 台" -f $small, $large)

$freeOnSystem = 0
$sysDrive = $env:SystemDrive.TrimEnd(':')
foreach ($v in $volumes) { if ([string]$v.DriveLetter -eq $sysDrive) { $freeOnSystem = [math]::Round($v.SizeRemaining / 1GB, 1) } }
if ($freeOnSystem -gt 0 -and $freeOnSystem -lt 60) {
    Write-Host ("  ⚠ {0}: 仅剩 {1} GiB。模板 VHDX + 每台 VM 的磁盘很快会耗尽 —— 做宿主必须挂数据盘。" -f `
        $env:SystemDrive, $freeOnSystem) -ForegroundColor Yellow
}

# ============================================================
# 5. 结论
# ============================================================
Write-Section '5. 结论'

if ($vmm) {
    Write-Host '  ✅ 本机向 Guest 暴露了 VT-x/AMD-V，具备嵌套虚拟化能力。' -ForegroundColor Green
    Write-Host '     下一步：Install-WindowsFeature -Name Hyper-V -IncludeManagementTools -Restart' -ForegroundColor Gray
    if ($large -eq 0) {
        Write-Host '     但资源账不成立：开不出 4C16G 的桌面 VM，只够少量小规格测试机。' -ForegroundColor Yellow
    }
    exit 0
}

Write-Host '  ❌ 本机未暴露 VT-x/AMD-V（VMMonitorModeExtensions = False）。' -ForegroundColor Red
Write-Host '     结论：Hyper-V 角色装上也无法运行 VM，这台机器不能做虚拟化宿主。' -ForegroundColor Red
Write-Host '     可选：① 改用云厂商原生 VM（一人一台 ECS）；② 退回共享 RDS 会话主机；' -ForegroundColor Gray
Write-Host '           ③ 换支持嵌套虚拟化的实例规格（需向阿里云工单确认）。' -ForegroundColor Gray

if (-not $isAdmin) {
    Write-Host '     注意：本次未以管理员运行，Hyper-V 角色状态未读到，结论基于 CPU 能力。' -ForegroundColor Yellow
    exit 3
}
exit 2
