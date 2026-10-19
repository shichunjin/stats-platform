<#
.SYNOPSIS
    强制普通用户的软件生成物只能落在各自私有目录（机器级配置，管理员运行一次）

.DESCRIPTION
    本脚本与 login.ps1 配合，构成"软件生成文件输出到各自指定目录"的强制保障。
    目录约定（与 app/config.py、setup-workspace-drive.ps1 一致）：
      W: = \\127.0.0.1\workspace\<用户名>   工作/输出，NTFS 仅本人可写
      待导出目录 = \\127.0.0.1\pending\<用户名>（登录脚本建桌面快捷方式，不映射盘符）
      Z: = \\127.0.0.1\StatsData             原始数据，只读

    本脚本（机器级，对所有后续安装的软件同样生效）：
      1. 通用"另存为/打开"对话框位置栏（PlacesBar）锁定为 W: / Z: / 待导出目录，
         任何 Windows 标准文件对话框都适用，不依赖具体软件；
      2. 可选 -HardenRootAcl：去掉普通用户在 C:\ 根创建文件夹的默认权限
         （%TEMP%、AppData、用户配置文件不受影响，软件可正常运行）。

    软件专有启动配置（原 R/RStudio 的 Rprofile.site、Stata 的 profile.do 固化段）
    已随软件下线一并移除。新接入软件若需固化启动目录，参照本脚本结构另行扩展。

    每用户级措施（桌面/文档/下载重定向到 W:、隐藏并禁止访问 C: 盘）在
    login.ps1 中于用户登录时下发，管理员账号自动豁免。

    幂等：重复运行安全，已写入的配置用标记块识别，不会重复追加。

.PARAMETER HardenRootAcl
    额外收紧 C:\ 根目录 NTFS（普通用户只剩遍历/读取，不能在根下新建文件夹/文件）。
    不确定时不要加：绝大多数软件不需要写 C:\ 根，但个别老旧安装程序可能受影响。

.EXAMPLE
    .\enforce-output-location.ps1
.EXAMPLE
    .\enforce-output-location.ps1 -HardenRootAcl
#>
#Requires -RunAsAdministrator
param(
    [switch]$HardenRootAcl
)

$ErrorActionPreference = "Stop"

# ============================================================
# 1. 通用文件对话框位置栏（PlacesBar）—— 对所有软件生效
# ============================================================
# 旧式打开/另存为对话框左侧栏只显示：我的工作区(W:)、原始数据(Z:)。
# 待导出目录是按用户名的 UNC 路径，无法在机器级策略里写死，
# 由 login.ps1 在每用户 HKCU 策略中追加 \\127.0.0.1\pending\<用户名>。
Write-Host "[1/2] 锁定机器级通用文件对话框位置栏（W: / Z:）..." -ForegroundColor Yellow
$placesHklm = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\ComDlg32\PlacesBar"
New-Item -Path $placesHklm -Force | Out-Null
New-ItemProperty -Path $placesHklm -Name "Place0" -Value "W:\" -PropertyType String -Force | Out-Null
New-ItemProperty -Path $placesHklm -Name "Place1" -Value "Z:\" -PropertyType String -Force | Out-Null
Write-Host "      所有标准打开/另存为对话框的快捷位置已锁定。" -ForegroundColor Green

# ============================================================
# 2. 可选：收紧 C:\ 根，普通用户不得在根下新建文件/文件夹
# ============================================================
Write-Host "[2/2] C:\ 根目录 NTFS 收紧..." -ForegroundColor Yellow
if ($HardenRootAcl) {
    # 仅替换 Users(S-1-5-32-545) 在 C:\ 根"本目录"的 ACE 为 RX；
    # 不带 (OI)(CI)，子目录（Program Files、Users\...）各自的 ACL 与继承不受影响，
    # %TEMP%、AppData、用户配置文件仍可写，软件正常运行。
    icacls "C:\" /grant:r "*S-1-5-32-545:(RX)" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "icacls C:\ 收紧失败" }
    Write-Host "      普通用户已不能在 C:\ 根创建文件/文件夹（仅遍历/读取）。" -ForegroundColor Green
} else {
    Write-Host "      跳过（加 -HardenRootAcl 可启用；不确定兼容性时保持跳过即可）。" -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "完成。生效说明：" -ForegroundColor Cyan
Write-Host "  - 机器级配置对新安装的软件同样适用（标准文件对话框位置栏）。" -ForegroundColor Cyan
Write-Host "  - 每用户措施（桌面/文档/下载 -> W:、隐藏 C: 盘）随下次登录由 login.ps1 下发。" -ForegroundColor Cyan
Write-Host "  - 新接入软件只需：安装后在 software-registry.json 增加一条（key/name/path/args），" -ForegroundColor Cyan
Write-Host "    复制到 C:\stats-scripts\ 并重新登录，login.ps1 即按注册表生成快捷方式（起始目录 W:）。" -ForegroundColor Cyan
Write-Host "  - 无启动配置机制的软件，结果默认落在源文件同目录；快捷方式起始目录为 W:，" -ForegroundColor Cyan
Write-Host "    且 C: 盘对普通用户隐藏，用户把源文件放在 W: 后结果自然落在私有目录。" -ForegroundColor Cyan
