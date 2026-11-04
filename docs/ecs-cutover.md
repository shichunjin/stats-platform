# 切到「一用户一 VM」+ 阿里云 ECS：上线清单

> 适用：共享 RDS 已跑通（Guacamole + TLS），要让用户各拿一台独立 Windows VM。
> 平台侧代码已就绪（`src/desktop/` 全套 + `provider/aliyun-ecs.ts`），本清单是**操作侧**的先后顺序。
> 顺序不能乱：每步都有「先验证再继续」的检查点，跳步会把问题推到更难排查的地方。

## 0. 前提

| 项 | 要求 |
|---|---|
| 共享 RDS 通道 | 已通（`Security mode: TLS`、桌面稳定、剪贴板可用） |
| guacd 网络 | 与 VM 在**同一 VPC**，能访问 3389 |
| 数据库 | 迁移到最新（`npm run db:migrate`），17 张表 + `desk_*` 8 张 |
| Node | ≥ 22.5 |

> ⚠️ 阿里云 ECS 不向 Guest 暴露 VT-x，**不要试图在本机跑 Proxmox/Hyper-V 宿主**；
> 本清单的 VM 全部是阿里云按量实例。

## 1. 控制台侧准备（一次性）

### 1.1 RAM 子账号

- 创建 RAM 用户，只勾选「OpenAPI 调用访问」，授权 `AliyunECSFullAccess`；
- 记录 AccessKey ID / Secret（**主账号 AK 不要用**）；
- 建议再收紧为自定义策略：`ecs:RunInstances`、`StartInstance`、`StopInstance`、
  `RebootInstance`、`DeleteInstance`、`DescribeInstances`、`DescribeImages`、
  `DescribeDisks`、`CreateSnapshot`。

### 1.2 网络

- 选一个**与 guacd 同 VPC** 的交换机（VSwitch），记录 `vsw-xxx`；
- 安全组入方向放行 3389，源填 guacd 所在机器的内网 IP/CIDR（**不要放行 0.0.0.0/0**）；
- 安全组**不要**放行 22 给公网（账号同步走内网）。

### 1.3 模板机 → 自定义镜像

在现在这台已跑通的 Windows 上：

```powershell
# 1) 跑模板固化（共享根、关 NLA、SecurityLayer=1、防火墙只放 guacd、OpenSSH、manifest）
.\powershell\prepare-desktop-template.ps1 -FileServer \\<文件服务器内网IP>\workspace
# 2) 确认它安排了 TermService 重启；重启后重新登录确认 RDP 仍是 TLS
# 3) 关机（镜像要求实例 Stopped）
Stop-Computer -Force
```

然后在 ECS 控制台：实例 → 云盘与镜像 → **创建自定义镜像**，记下镜像 ID（`m-xxx`）。
镜像里必须已包含：OpenSSH Server（账号同步用）、`C:\stats-scripts\`、`template-manifest.json`。

## 2. 平台侧配置

```bash
# .env
DESKTOP_ENABLED=false          # 先别开，等模板登记 + 冒烟都通过
DESKTOP_PROVIDER=ecs
ALIYUN_ACCESS_KEY_ID=LTAI...
ALIYUN_ACCESS_KEY_SECRET=...
ALIYUN_REGION_ID=cn-hangzhou
ALIYUN_VSWITCH_ID=vsw-xxx
ALIYUN_SECURITY_GROUP_ID=sg-xxx
ALIYUN_INSTANCE_TYPE=ecs.g6.xlarge
ALIYUN_INITIAL_PASSWORD=<强密码>   # VM 首启后由改密链路立即换掉
ALIYUN_SYSTEM_DISK_CATEGORY=cloud_essd
ALIYUN_STOP_CHARGING=false        # 账号未开「停机不收费」时保持 false

# 静态 IP 池（可选但推荐：开机即可连，不必等 Guest 回读）
DESKTOP_SUBNET=172.25.3.0/24
DESKTOP_GATEWAY=172.25.3.1
```

> `DESKTOP_SUBNET` 必须落在 VSwitch 网段内，且池子里的地址要预先灌进
> `desktop_ip_allocations`——用灌池脚本（默认 dry-run，确认后 `--apply` 写库，
> 幂等可重跑，自动排除网络/广播/网关地址）：
>
> ```bash
> npx tsx scripts/seed-ip-pool.ts                      # dry-run，按 .env 的 DESKTOP_SUBNET 出计划
> npx tsx scripts/seed-ip-pool.ts --apply              # 确认无误后写库
> # 灰度想先小池子：npx tsx scripts/seed-ip-pool.ts --first 20 --apply
> ```

```bash
npm run build && systemctl restart stats-platform && sleep 12
systemctl is-active stats-platform
```

## 3. 冒烟（**必做**，签名对错只有真调才知道）

```bash
# 只读：验签名 + 镜像 Available + DescribeInstances 权限（无费用）
npx tsx scripts/ecs-smoke.ts --image m-xxxx

# 完整：RunInstances → 开机 → 销毁（几十秒，几分钱）
npx tsx scripts/ecs-smoke.ts --image m-xxxx --create
```

常见报错对照：

| 报错 | 原因 |
|---|---|
| `SignatureDoesNotMatch` | AK Secret 错 / 本机时间偏离超过 15 分钟 |
| `Forbidden.RAM` | 子账号缺 ECS 权限 |
| `InvalidImageId.NotFound` | 镜像不在该 Region，或 ID 抄错 |
| `InvalidVSwitchId.NotFound` | VSwitch 不在该 Region |
| `InvalidInstanceType.ValueNotSupported` | 机型在该可用区不售 |
| `QuotaExceeded.Instance` | 按量实例配额不足（提工单或释放闲置实例） |

## 4. 登记模板

```bash
curl -X POST https://<你的域名>/admin/desktop-templates \
  -H "Authorization: Bearer <管理员 token>" -H "Content-Type: application/json" \
  -d '{"code":"win2022-ecs-v1","name":"统计桌面 ECS v1","provider":"ecs",
       "provider_ref":"m-xxxx","vcpu":4,"memory_mb":8192,"disk_gb":120,
       "guest_username":"Administrator","is_default":true}'
```

- `provider` 必须等于 `DESKTOP_PROVIDER`，否则 422；
- `provider_ref` 必须是镜像 ID（`m-` / `ami-` 开头），写 `pve1/9001` 会被拒；
- 设为默认时旧默认会自动取消（部分唯一索引要求唯一）。

同时确认配额（`/admin/desktop-quotas`）绑的是这个模板，`default_vcpu/memory_mb`
不要超过 `max_*`，`destroy_after_idle_days ≥ max_idle_days`。

## 5. 灰度开闸

```sql
-- 先只给一个测试用户开
UPDATE users SET desktop_mode = 'vm', desktop_enabled = true WHERE username = 'testuser';
```

```bash
# .env: DESKTOP_ENABLED=true
npm run build && systemctl restart stats-platform && sleep 12
```

该用户登录 → 前端调 `/desktop/ensure` → worker 创建 VM。

```bash
# 看任务队列（卡住的第一现场）
curl -s https://<域名>/admin/desktop-tasks?status=running -H "Authorization: Bearer <token>"
# 看 worker 日志
journalctl -u stats-platform -f | grep -i desktop
```

状态机：`new → provisioning → configuring → booting → probing → awaiting_account → ready`
（首次登录前是 `awaiting_account`：VM 里还没有 Windows 账号，登录时自动同步，见 A16）

## 6. 验收清单

- [ ] `ecs-smoke.ts` 只读 + `--create` 都通过
- [ ] `/desktop/ensure` 返回 `mode=vm` 且 `task_id > 0`
- [ ] 3~5 分钟内实例到 `ready`/`awaiting_account`，`desktop_vms.primary_ip` 有值
- [ ] 浏览器能连上该 VM（`Security mode: TLS`，不是 NLA）
- [ ] VM 里复制粘贴可用（`GUAC_CLIPBOARD_ENABLED=true` + `fDisableClip=0`）
- [ ] 改一次平台密码 → VM 里的 Windows 密码同步（`account_synced_at` 更新）
- [ ] 管理端「强制回收」→ 实例 `destroyed`、IP 回池、`guac_connection_map` 解绑
- [ ] 回收后用户再申请 → 新建一台，不报 `uq_guac_map_conn` 冲突

## 7. 成本与回收

- reaper 默认：**空闲 7 天挂起、30 天销毁、180 天重建**（天数在 SQL 内按 UTC 算）；
- `suspended` 状态的实例走 `StopCharging` 只收磁盘费（需账号开启停机不收费）；
- 每日时长配额 `max_daily_hours` 由配额表控制，超出后 worker 不再唤醒。

## 8. 回滚

```bash
# 1) 关闸：新申请一律走老 RDS
DESKTOP_ENABLED=false && systemctl restart stats-platform

# 2) 收尾存量 VM（管理端不看你这个开关）
curl -X POST https://<域名>/admin/desktops/<id>/recycle -H "Authorization: Bearer <token>"

# 3) 或只把用户切回 rds 模式
UPDATE users SET desktop_mode = 'rds' WHERE desktop_enabled = true;
```

`DESKTOP_PROVIDER` 切回 `proxmox` 前，记得把 `desktop_templates` 里那条 `provider='ecs'`
的默认模板取消（否则 `/desktop/ensure` 会因 provider 不一致返回 503，且报错会点名是哪条模板）。
