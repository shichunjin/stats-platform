# 测试环境角色分配与部署步骤（两台阿里云 ECS）

> 适用环境：1 台 Alibaba Cloud Linux 4 + 1 台 Windows Server 2022 Datacenter
> （通用型 4 vCPU / 16 GiB / ESSD 80 GiB）
>
> 本文是**操作性文档**，架构与取舍的推导见 `docs/multi-vm-desktop-plan.md`。
> 结论先看第 0 章，动手照第 3、4 章。

---

## 0. 结论：角色分配

| 机器 | 角色 | 承担组件 | 关键产出 |
|---|---|---|---|
| **Linux ECS**（ALinux 4） | 控制面 + 网关 + 文件服务器 | PostgreSQL 16、Fastify 后端、DMS worker/reaper、Guacamole 1.6.0（Docker）、nginx、Samba 共享 | 平台可访问；`\\<linux-ip>\{StatsData,workspace,pending}` 可读写 |
| **Windows ECS**（2022 DC / 4C16G / 80G） | **桌面母机（金镜像）** | 统计软件、`login.ps1` + `software-registry.json`、OpenSSH、RDP 参数、`template-manifest.json` | 一个自定义镜像 ID，供派发用户桌面 |

**两台都不是虚拟化宿主。** 这两台上的"一人一台 VM"必须由云厂商提供 —— 即每用户一台 ECS，
Windows 那台负责产出镜像，Linux 那台负责调度与网关。

---

## 1. 为什么不能在这两台里再开 VM

### 1.1 阿里云普通 ECS 不向 Guest 暴露 VT-x/AMD-V

Hyper-V 角色在 Windows Server 上是自带的、**装得上**，但一启动 VM 就报
「虚拟机监控程序未运行」——因为 `vmx`/`svm` 对 Guest 不可见。这一步只有装完角色、
重启之后才暴露，回滚成本高（要卸角色 + 再重启）。

先探测，一条命令（**在实际的 Windows 机上跑**，别在本地机器跑）：

```powershell
(Get-CimInstance Win32_Processor).VMMonitorModeExtensions   # False ⇒ 不可做宿主
```

仓库里有完整探测脚本（只读，不装任何东西、不重启）：

```powershell
.\powershell\check-virtualization.ps1
```

它一次输出：机型身份、CPU 虚拟化能力、Hyper-V 角色状态、资源账（能开几台）、结论，
退出码 `0=可做宿主 / 2=不可做宿主 / 3=判定不完整`。

### 1.2 资源账本身也不成立

4 vCPU / 16 GiB 扣掉 Windows 自身（约 4 GiB、1 vCPU）后剩 **12 GiB / 3 vCPU**：

- 开一台 **4C16G** 的桌面 VM —— 开不出来（内存和 vCPU 都不够宿主自己用）；
- 开 **2C4G** 的测试 VM —— 最多 3 台，但 80 GiB 系统盘装完 Windows + 统计软件只剩二十来 G，
  模板 VHDX（40 G 起）+ 每台 VM 的磁盘立刻爆。做宿主**必须**再挂数据盘。

### 1.3 代码侧只有 Proxmox 一个实现

`src/desktop/provider/proxmox.ts` 是 `DesktopProvider` 的唯一实现。所以：

- 走 **ECS 派发** → 新增 `aliyun-ecs.ts`（接口已就绪，映射表见第 7 章）；
- 走 **嵌套 Hyper-V** → 新增 `hyperv.ts`，但受 1.1 / 1.2 双重限制，只能冒烟；
- 本地有物理服务器时 → 才轮到现在的 Proxmox 实现（PVE 装在物理机上，不在云主机里）。

---

## 2. 三条路线怎么选

| 路线 | 形态 | 前置条件 | 代价 | 适用 |
|---|---|---|---|---|
| **R1 ECS 派发**（推荐） | 每用户一台 ECS，Windows 出镜像 | 自定义镜像 + RAM 实例角色 + 新增 Provider | 写 `aliyun-ecs.ts`；按量计费 | 生产形态 |
| **R2 共享 RDS** | Windows 单机多用户会话（现状） | 无 | 无隔离，统计软件抢 CPU/内存 | 过渡、演示、验收平台功能 |
| **R3 嵌套 Hyper-V** | Windows 装 Hyper-V 开 VM | 1.1 探测为 True + 数据盘 | 只够 1~3 台 2C4G，不能生产 | 冒烟（大概率不可行） |

**建议的推进顺序**：先按 R2 把平台跑通（今天就能用）→ Windows 机定型后做自定义镜像
→ 再切 R1。这样即使 R1 的 Provider 还没写完，业务侧也能先验收。

---

## 3. Linux 机操作步骤（L1 ~ L9）

> 全部命令在 Linux ECS 上以 root 或 sudo 执行。下文 `10.0.0.10` 代表 Linux 内网 IP，
> `10.0.0.20` 代表 Windows 内网 IP，按实际替换。

### L1 系统基线

```bash
hostnamectl set-hostname stats-linux
timedatectl set-timezone Asia/Shanghai
dnf -y update
# 测试期可先关掉防火墙；生产改为按端口放行（见 L9）
systemctl disable --now firewalld
```

### L2 PostgreSQL 16 + 两个库

```bash
dnf install -y https://download.postgresql.org/pub/repos/yum/reporpms/EL-9-x86_64/pgdg-redhat-repo-latest.noarch.rpm
dnf -qy module disable postgresql
dnf install -y postgresql16-server postgresql16
/usr/pgsql-16/bin/postgresql-16-setup initdb
systemctl enable --now postgresql-16
```

```sql
-- sudo -u postgres psql
CREATE USER stats WITH PASSWORD '<强密码>';
CREATE DATABASE stats_platform OWNER stats;

-- Guacamole 独立库：升级要重建 guacamole_* 表，与业务库分开才不会误伤
CREATE USER guacamole_user WITH PASSWORD '<另一个强密码>';
CREATE DATABASE guacamole_db OWNER guacamole_user;
```

`postgresql.conf` 需允许内网连接（Guacamole 容器走宿主机回环，只有平台后端需要）：

```
listen_addresses = 'localhost'     # 容器用 host.docker.internal，无需对外
```

### L3 Node.js 22 + git

```bash
dnf install -y git
curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
dnf install -y nodejs
node -v     # 必须 ≥ 22.5（迁移脚本用内置 node:sqlite）
```

### L4 部署后端

```bash
mkdir -p /opt && cd /opt
git clone git@github.com:shichunjin/stats-platform.git
cd stats-platform
npm ci
cp .env.example .env
vi .env          # 必填项见下表
npm run build
npm run db:migrate
```

`.env` 最小必填（其它保持默认）：

| 变量 | 值 |
|---|---|
| `DATABASE_URL` | `postgres://stats:<密码>@127.0.0.1:5432/stats_platform` |
| `JWT_SECRET` | 32 字节以上随机串 |
| `GUAC_DB_URL` | `postgresql://guacamole_user:<密码>@127.0.0.1:5432/guacamole_db` |
| `GUACAMOLE_URL` / `GUACAMOLE_ADMIN_PASSWORD` | Guacamole 访问地址与管理员密码 |
| `PS_LOGIN_SCRIPT` | `\\10.0.0.10\scripts\login.ps1`（R1 时是共享路径；R2 同机可留默认） |
| `STATS_FILE_SERVER` | `10.0.0.10`（Windows 上 `-FileServer` 也用这个值） |
| `DESKTOP_ENABLED` | R2 期 `false`；R1 就绪后 `true` |

### L5 Guacamole 1.6.0

```bash
cd /opt/stats-platform/guacamole
cp .env.example .env      # 填 POSTGRES_PASSWORD（与 guacamole_user 一致）
psql "postgresql://guacamole_user:<密码>@127.0.0.1:5432/guacamole_db" -f initdb.sql
docker compose up -d
docker compose ps         # guacd + guacamole 都 Up
```

> 必须 1.6.0 及以上：1.5.x 内置 FreeRDP 与 Server 2022 的 TLS 协商不兼容
> （GUACAMOLE-1920），现象是"凭据正确但认证失败"。

### L6 Samba 文件服务器（多 VM 的共享根）

一人一台 VM 之后，`\\127.0.0.1` 指向 VM 自己，W:/Z: 会直接断链 —— 所以共享根必须落在
这台 Linux 上。目录结构与后端 `src/config/env.ts` 严格一致：

```
/srv/stats/StatsData        # Z: 原始数据，只读
/srv/stats/workspace/<用户>  # W: 私有工作区，仅本人可写
/srv/stats/pending/<用户>    # 待导出暂存
/srv/stats/scripts          # login.ps1 + software-registry.json（供 PS_LOGIN_SCRIPT 用）
```

```bash
dnf install -y samba samba-client
mkdir -p /srv/stats/{StatsData,workspace,pending,scripts}
# SELinux：允许 samba 读写（ALinux 4 默认 enforcing）
setsebool -P samba_export_all_rw on
```

`/etc/samba/smb.conf` 关键片段：

```ini
[global]
   security = user
   passdb backend = tdbsam
   server min protocol = SMB3
   map to guest = never

[StatsData]
   path = /srv/stats/StatsData
   read only = yes
   valid users = @statsusers

[workspace]
   path = /srv/stats/workspace
   read only = no
   valid users = @statsusers
   # 每用户自己的子目录由 ACL 限制，见下

[pending]
   path = /srv/stats/pending
   read only = no
   valid users = @statsusers

[scripts]
   path = /srv/stats/scripts
   read only = yes
   valid users = @statsusers
```

账号必须与平台、Windows **三端同名同密码**（方案 A′，因为 `login.ps1` 的 `net use`
走 SMB 透传，没有凭据就靠同密码认证）：

```bash
groupadd -f statsusers
useradd -M -s /sbin/nologin alice && usermod -aG statsusers alice
smbpasswd -a alice          # 密码 = 平台密码 = Windows 本地账号密码
mkdir -p /srv/stats/workspace/alice /srv/stats/pending/alice
chown alice:statsusers /srv/stats/workspace/alice /srv/stats/pending/alice
chmod 700 /srv/stats/workspace/alice /srv/stats/pending/alice
systemctl enable --now smb
```

### L7 后端常驻（systemd）

```ini
# /etc/systemd/system/stats-platform.service
[Unit]
Description=stats-platform backend
After=network.target postgresql-16.service

[Service]
Type=simple
WorkingDirectory=/opt/stats-platform
EnvironmentFile=/opt/stats-platform/.env
ExecStart=/usr/bin/node dist/src/index.js
Restart=always
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now stats-platform
journalctl -u stats-platform -n 50 --no-pager
```

### L8 nginx + HTTPS（可选，但有公网域名就做）

```bash
dnf install -y nginx
cp /opt/stats-platform/nginx/nginx-stats-platform.conf /etc/nginx/conf.d/
nginx -t && systemctl enable --now nginx
# 证书：certbot --nginx -d <域名>
```

### L9 验收

```bash
curl -s http://127.0.0.1:8000/health
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8000/login
ss -lntp | grep -E '8000|8080|5432|445'
```

防火墙（若要开）：`80/443` 对公网，`8080/445/5432` 只对 `10.0.0.20`（Windows）与运维 IP。

---

## 4. Windows 机操作步骤（W1 ~ W9）

> 依次执行。**W7 sysprep 之后本机就不能再当生产桌面用**，所以顺序不要跳：
> 先跑通 W1~W6 验证，再做镜像。

### W1 系统基线

```powershell
Set-TimeZone -Id 'China Standard Time'
Rename-Computer -NewName 'win2022-stats-base' -Restart   # 模板名，克隆后由 DMS 改
# 补丁
Install-Module PSWindowsUpdate -Force -Confirm:$false
Get-WindowsUpdate -Install -AcceptAll -AutoReboot
```

### W2 装业务软件

按 `powershell/software-registry.json` 清单装（SPSS / Stata / R / Python 等），
装完确认**桌面快捷方式与注册表里的 `exe` 路径一致** —— `login.ps1` 是按清单建快捷方式的，
路径对不上就会出现"桌面有图标、点开报错"。

### W3 OpenSSH Server（平台推送数据用）

由 `prepare-desktop-template.ps1` 自动装（见 W4），但公钥要手工放：

```powershell
# 把 Linux 侧的公钥写进管理员授权文件（仅 Administrators / SYSTEM 可写，否则 sshd 拒绝加载）
$key = 'ssh-ed25519 AAAA... stats@linux'
$f = "$env:ProgramData\ssh\administrators_authorized_keys"
Add-Content -Path $f -Value $key -Encoding ascii
icacls $f /inheritance:r /grant 'Administrators:F' 'SYSTEM:F'
Restart-Service sshd
```

### W4 部署脚本 + 固化共享根（一条命令）

```powershell
cd C:\path\to\stats-platform\powershell
Set-ExecutionPolicy Bypass -Scope Process -Force

.\prepare-desktop-template.ps1 `
    -FileServer 10.0.0.10 `
    -GuacdSource 10.0.0.10 `
    -PlatformSource 10.0.0.10 `
    -TemplateName win2022-stats-v1
```

它做七件事：固化共享根（`HKLM\SOFTWARE\StatsPlatform\FileServer` + 机器级
`STATS_FILE_SERVER`）→ 部署脚本到 `C:\stats-scripts`（**含 `lib\`**）→ 关 NLA +
`SecurityLayer=1` + 禁剪贴板/驱动器/打印机 → 3389/22 按来源收敛 →
OpenSSH → Guest Agent 检查 → 写 `template-manifest.json`。退出码非 0 不要转模板。

> ⚠️ 关 NLA 之后，后端 `.env` 必须是 `GUAC_RDP_SECURITY=tls` +
> `GUAC_RDP_IGNORE_CERT=true`，否则 Guacamole 仍按 NLA 发起协商，登录必然失败。

### W5 验证登录脚本（转模板前必做）

```powershell
# 以普通用户身份登录一次（RDP 或 mstsc /admin 后切换），然后检查：
Test-Path '\\10.0.0.10\workspace\alice'      # 共享可达
net use                                        # W:/Z: 已映射
Test-Path 'W:\Desktop'                         # 桌面已重定向
[Environment]::GetEnvironmentVariable('STATS_FILE_SERVER','Machine')
```

### W6 三端同密码的测试账号

```powershell
# 用户名和密码必须与平台账号、Samba 账号完全一致
New-LocalUser -Name 'alice' -Password (ConvertTo-SecureString '<平台密码>' -AsPlainText -Force) `
    -PasswordNeverExpires -UserMayNotChangePassword:$false
Add-LocalGroupMember -Group 'Remote Desktop Users' -Member 'alice'
```

`login.ps1` 用 `net use` 免凭据访问共享，密码不一致就会在登录时弹"拒绝访问"或
映射出红叉 —— 这是最高频的故障，别跳过。

### W7 sysprep（做镜像前）

```powershell
C:\Windows\System32\Sysprep\sysprep.exe /generalize /oobe /shutdown /mode:vm
```

机器自动关机。**sysprep 会重置 Administrator 密码并清 SID** —— 这正是
`awaiting_account` 状态存在的原因：镜像派生的新机上没有平台用户的本地账号，
用户首次登录（或首次连接）时才触发 `notifyVmPasswordChange` 补建。

### W8 控制台创建自定义镜像

ECS 控制台 → 实例 → 创建自定义镜像（关机状态，系统盘 80 G）→ 记下 `ImageId`。
同时打一个快照，镜像做坏了能回滚。

### W9 用镜像开一台验证机

按 `4 vCPU / 16 GiB / ESSD 80 GiB` 开一台，验证：RDP 可连 → W:/Z: 正确 →
统计软件能启动 → `C:\stats-scripts\template-manifest.json` 存在且版本与
`desktop_templates.login_script_ver` 一致。全过才把镜像登记进平台。

---

## 5. 两台机器必须对齐的四件事

1. **共享根**：Windows 上 `-FileServer` = Linux 内网 IP，绝不能是 `127.0.0.1`
   （VM 里的 127.0.0.1 是它自己）。
2. **账号**：Samba / Windows 本地账号 / 平台账号 三端同名同密码（方案 A′）。
3. **端口**：`3389` 只放行 guacd 出口；`22` 只放行 Linux；`445` 内网；
   `8080` 不对公网。
4. **时区**：两台都 `Asia/Shanghai`。数据库列是 `timestamp without time zone`，
   reaper 的"7 天/30 天"判断在 SQL 里用 `now() AT TIME ZONE 'UTC'` 算，
   机器时区不一致会把边界判断拖偏。

---

## 6. 验收清单

- [ ] Linux：`/health` 200，`/login` 200，Guacamole 能登录
- [ ] Linux：`smbclient -L //127.0.0.1 -U alice` 能列出四个共享
- [ ] Windows：`Test-Path \\<linux>\workspace\alice` 为 True
- [ ] Windows：普通用户登录后 W:/Z: 自动映射，桌面无"位置不可用"弹窗
- [ ] Windows：`template-manifest.json` 生成，退出码 0
- [ ] 镜像：新开一台实例，RDP 连得上、软件起得来
- [ ] 平台：`desktop_mode` / `desktopEnabled` 与所选路线一致（R2 必须为 `false`）

---

## 7. 走 R1 时需要补的代码（映射表）

`DesktopProvider` 接口与 ECS OpenAPI 是 1:1 的，新增 `src/desktop/provider/aliyun-ecs.ts` 即可，
业务侧一行不用改：

| 接口 | ECS OpenAPI |
|---|---|
| `clone(template, spec)` | `RunInstances`（`ImageId` / `InstanceType` / `SecurityGroupId` / `VSwitchId`） |
| `start(ref)` | `StartInstance` |
| `power(ref,'stop')` | `StopInstance`（`ForceStop=true`） |
| `shutdown(ref, timeout)` | `StopInstance`（优雅）→ 超时降级 Force |
| `destroy(ref)` | `DeleteInstance` |
| `inspect(ref)` | `DescribeInstances`（`Status` + 私网 IP） |
| `snapshot(ref, name)` | `CreateSnapshot` |
| `capacity(node)` | `DescribeInstanceTypes` + 配额中心接口 |

另外三处需要改：

1. **鉴权**：优先用**实例 RAM 角色**（`EcsRamRole` 走元数据服务拿 STS），不要在
   `.env` 里放 AccessKey —— 云主机上落盘的长效密钥是最常见的泄漏源。
2. **IPAM 表角色变化**：VPC 是 DHCP 分配，`desktop_ip_allocations` 从"分配器"降级为
   "记录器"，`allocateIp` 改成开机后回填实际私网 IP。
3. **`desktop_templates.provider_ref`**：Proxmox 存 `<node>/<vmid>`，ECS 存 `ImageId`。
   方案已定义成统一字符串，正好不用改表。

> 工作量的真实分布：Provider 约 300 行 + 测试；真正的坑在**首次开机到可 RDP**
> 这段时间（RunInstances → 系统初始化 → 3389 可连，通常 60~120 s），
> `start` 任务的总预算要按这个设，别沿用 Proxmox 的 120 s 一把梭。

---

## 8. 从现有单机形态的增量修改（Guacamole 已跑通）

> 前提：现在已跑通的形态是**单机共享 RDS** —— 数据 `C:\StatsData`、工作区
> `C:\workspace` 都在 Windows 本机，SMB 共享已由 `setup-*.ps1` 建好，
> 脚本里的 `\\127.0.0.1\...` 指向自己。Guacamole 免密直连正常。
>
> 本节目标：**不写一行代码**，把共享根从 `127.0.0.1` 换成固定内网 IP、
> 平台升级到含桌面 DMS 表的版本、RDP 参数定型。文件服务器暂时仍在
> Windows 机上（SMB server 是 Windows 自带，SFTP + icacls 链路完全兼容），
> 等 R1 的 Provider 就绪后再迁 Linux（见 8.5）。

### 8.0 备份与时机（5 分钟）

```powershell
# Windows（管理员 PowerShell）：控制台快照 + 记录当前 RDP 配置
reg query "HKLM\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp" `
    /v UserAuthentication
reg query "HKLM\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp" `
    /v SecurityLayer
```

```bash
# Linux
cd /opt/stats-platform && cp .env ".env.bak.$(date +%F)"
```

选低峰期执行：第 2 步会重启 RDP 服务，**在线会话断开一次**（重连即可，数据不丢）。

### 8.1 Linux 侧（10 分钟，不影响在线用户）

```bash
cd /opt/stats-platform
git pull && npm ci && npm run build
npm run db:migrate        # 新增 desktop_* 8 张表 + 0001/0002 两个迁移
vi .env
systemctl restart stats-platform
```

`.env` 改动（其余保持不动，`SFTP_HOST` / `WINDOWS_DATA_DIR` 原样）：

```ini
# 共享根：从"本机"变为固定 IP（R1 就绪前，文件服务器仍在 Windows 机）
STATS_FILE_SERVER=<Windows内网IP>
PS_LOGIN_SCRIPT=\\<Windows内网IP>\scripts\login.ps1

# RDP 参数：与 W4 固化结果对齐（脚本关 NLA ⇒ 必须 tls）
GUAC_RDP_SECURITY=tls
GUAC_RDP_IGNORE_CERT=true

# 新架构 DMS 开关：暂不启用。Proxmox Provider 在云上没有宿主可连，
# 打开只会让 worker 空转报错
DESKTOP_ENABLED=false
DESKTOP_WORKER_ENABLED=false
```

### 8.2 Windows 侧（15 分钟，RDP 会话断开一次）

```powershell
# 1) 更新脚本（最省：只同步 powershell 目录；或在 Linux 上 scp 过去）
cd C:\path\to\stats-platform && git pull

# 2) 固化（管理员 PowerShell）
cd powershell
Set-ExecutionPolicy Bypass -Scope Process -Force
.\prepare-desktop-template.ps1 `
    -FileServer <Windows内网IP> `
    -GuacdSource  <Linux内网IP> `
    -PlatformSource <Linux内网IP> `
    -TemplateName win2022-stats-base
```

脚本依次完成：注册表 + 机器级环境变量固化 `\\<Windows内网IP>`
（等效替换四个脚本里所有 `\\127.0.0.1`）→ 部署 `C:\stats-scripts`（含 `lib\`）→
关 NLA + `SecurityLayer=1` + 禁剪贴板/驱动器/打印机 → 3389/22 按来源收敛 →
OpenSSH 检查 → 写 `template-manifest.json`。**退出码非 0 时停下看输出，不要继续。**

### 8.3 验证（10 分钟，按顺序）

1. 浏览器登录平台 → 连接桌面 → **免密直连成功**（此时 RDP 走 tls）；
2. 桌面内 `net use`：W:/Z: 映射仍正确（启动项跑的是新版 `login.ps1`）；
3. 管理员发起一次数据筛选申请 → Excel 落到用户 W: 盘（SFTP + icacls 链路未动，应无感）；
4. `Test-Path \\127.0.0.1\workspace` → True（共享根是本机 IP，本机访问一样通）；
5. `C:\stats-scripts\template-manifest.json` 存在，`login_script_ver` 与
   `desktop_templates.login_script_ver` 对得上（填库时用）。

### 8.4 明确先不做的

- **sysprep / 做镜像**：会重置这台生产桌面（Administrator 密码清空、SID 重置）。
  等 ECS Provider 就绪、或另开一台临时机当母机时再做；真要做，先快照 + 选停机窗口。
- **数据迁 Linux / Samba**：等 R1 一起切（见 8.5）。
- **`DESKTOP_ENABLED=true`**：现在打开没有任何 VM 可管。

### 8.5 将来迁文件服务器到 Linux 的唯一代码改动点

现状 `src/routers/data.ts:74` 上传后用 `icacls` 锁 NTFS ACL（Windows 专属命令）。
数据源切到 Linux Samba 后，这一步要换成 Unix 权限等价物（`chmod 700` / 属主收敛）。
这是整条链路**唯一**必须改代码的地方；SFTP 目标改指向 Linux 本机（`SFTP_HOST=127.0.0.1`、
`WINDOWS_DATA_DIR=/srv/stats/StatsData`）只需改配置。迁移窗口内用
`scp -r` 把 `C:\StatsData` 拉回 `/srv/stats/StatsData` 即可。
