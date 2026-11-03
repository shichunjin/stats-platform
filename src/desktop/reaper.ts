/**
 * 空闲回收扫描器 —— docs/multi-vm-desktop-plan.md 9.5（7 天挂起 / 30 天销毁 / 180 天强制重建）
 *
 * 它只做**判定与入队**，真正的挂起/销毁/重建在 `tasks/*` 里，由队列串行执行。
 * 这样扫描是纯读+轻写（毫秒级），不会因为一台机器关机慢而拖住整批。
 *
 * ## 判定优先级（顺序即语义，别调换）
 *
 *   ① connected 超 grace → 降级 idle
 *   ② 账号停用          → 立即回收（离职账号的机器不该继续占资源）
 *   ③ 空闲 ≥ 销毁线     → 回收
 *   ④ VM 机龄 ≥ 重建线  → 重建（配额 allow_rebuild=false 时跳过）
 *   ⑤ 空闲 ≥ 挂起线     → 挂起
 *
 * ③ 在 ④ 之前：销毁比重建更彻底，能销毁就别浪费一次克隆。
 * ④ 在 ⑤ 之前：到了换机周期就别先挂起再等下一次唤醒。
 *
 * ## 空闲基线怎么来（这块最容易设计错）
 *
 * Guacamole 没有「会话结束」回调，平台拿不到真实的断开时刻，只能用近似：
 *  - 用户点连接 → `/session/connect` 写 `last_connected_at`、状态 `connected`；
 *  - `connected` 超过 `desktopConnectedGraceHours` 没有任何活动 → 视为已断开，
 *    降级为 `idle`，并把 `last_disconnected_at` 设为**当时的 last_connected_at**。
 *    注意是「当时」而不是 now —— 否则每次扫描都重置计时，桌面永远到不了期。
 *  - 之后按 `COALESCE(last_disconnected_at, last_connected_at, created_at)` 计天。
 *
 * ## 为什么天数在 SQL 里算
 *
 * `desk_instances.*` 是 `timestamp without time zone`，而 drizzle 写库用 UTC 墙钟、
 * 读库按本地时区解析（本机 +08 时区实测偏移 8 小时）。天数一律在 SQL 侧用
 * `now() AT TIME ZONE 'UTC'` 与同口径的列相减，避免把 8 小时误差带进
 * 「7 天」这种边界判断。TS 里只处理算好的浮点天数。
 *
 * ⚠️ 用户停用（`users.is_active=false`）的桌面优先回收，不看空闲天数。
 * ⚠️ 重建的计时基准是**当前 VM 的 created_at**，不是实例的 —— 实例行会跨多次
 * 重建存活，用实例时间会导致「刚重建完第二天又到线」的死循环。
 */
import { sql } from 'drizzle-orm';
import { getSettings } from '../config/env.js';
import { withSession } from '../db/session.js';
import { enqueueTask } from './queue.js';

const HOURS_PER_DAY = 24;

/** `desktop_quotas.rebuild_after_days` 的 DDL 默认值；配额行为 null 时的兜底 */
const DEFAULT_REBUILD_DAYS = 180;

export type SweepActionKind = 'idle' | 'suspend' | 'recycle' | 'rebuild';

export interface SweepAction {
  readonly kind: SweepActionKind;
  readonly instanceId: number;
  readonly reason: string;
}

interface CandidateRow {
  readonly id: number;
  readonly user_id: number | null;
  readonly status: string;
  readonly is_active: boolean | null;
  /** connected 状态距 last_connected_at 的天数（null = 没有记录） */
  readonly connected_idle_days: number | string | null;
  /** COALESCE(last_disconnected_at, last_connected_at, created_at) 距今天数 */
  readonly idle_days: number | string | null;
  readonly idle_limit: number | string | null;
  readonly destroy_limit: number | string | null;
  /** 当前 VM 的机龄（天数）；无 VM 为 null */
  readonly vm_age_days: number | string | null;
  readonly rebuild_limit: number | string | null;
  readonly allow_rebuild: boolean | null;
}

const asNum = (value: number | string | null, fallback: number): number => {
  if (value === null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/** UTC 日期串（task_key 幂等粒度：同一实例每天最多挂起/销毁一次） */
const dayKey = (at: Date): string => at.toISOString().slice(0, 10).replace(/-/g, '');

/**
 * 扫一轮：返回本轮判定出的动作（已入队）。
 * 幂等靠 `task_key`（`suspend:instance:<id>:<yyyymmdd>`），重复扫描不会重复入队。
 */
export const sweepIdleInstances = async (): Promise<readonly SweepAction[]> => {
  const settings = getSettings();
  const graceDays = settings.desktopConnectedGraceHours / HOURS_PER_DAY;
  const defaultSuspendDays = settings.desktopIdleSuspendDays;
  const defaultDestroyDays = settings.desktopIdleDestroyDays;

  const candidates = await withSession(async (db) => {
    const result = await db.db.execute(sql`
      SELECT i.id, i.user_id, i.status,
             u.is_active,
             EXTRACT(EPOCH FROM ((now() AT TIME ZONE 'UTC') - i.last_connected_at)) / 86400.0
               AS connected_idle_days,
             EXTRACT(EPOCH FROM ((now() AT TIME ZONE 'UTC')
               - COALESCE(i.last_disconnected_at, i.last_connected_at, i.created_at))) / 86400.0
               AS idle_days,
             EXTRACT(EPOCH FROM ((now() AT TIME ZONE 'UTC') - v.created_at)) / 86400.0
               AS vm_age_days,
             q.max_idle_days            AS idle_limit,
             q.destroy_after_idle_days  AS destroy_limit,
             q.rebuild_after_days       AS rebuild_limit,
             q.allow_rebuild            AS allow_rebuild
      FROM desk_instances i
      JOIN users u ON u.id = i.user_id
      LEFT JOIN desktop_quotas q ON q.id = i.quota_id
      LEFT JOIN desktop_vms v ON v.id = i.current_vm_id
      WHERE i.status IN ('connected', 'idle', 'ready', 'suspended', 'awaiting_account')
    `);
    return (result as unknown as { rows: readonly CandidateRow[] }).rows ?? [];
  });

  const actions: SweepAction[] = [];
  const today = dayKey(new Date());

  for (const row of candidates) {
    const instanceId = Number(row.id);
    const userId = row.user_id === null ? null : Number(row.user_id);

    // ① connected 但久无活动 → 降级 idle（写库时用列对列赋值，不经 TS 的 Date 往返）
    let { status } = row;
    let idleDays = asNum(row.idle_days, 0);

    if (status === 'connected') {
      const connectedIdleDays = asNum(row.connected_idle_days, 0);
      if (connectedIdleDays < graceDays) continue;

      await withSession(async (db) => {
        await db.db.execute(sql`
          UPDATE desk_instances
          SET status = 'idle', last_disconnected_at = last_connected_at
          WHERE id = ${instanceId}
        `);
        await db.commit();
      });
      status = 'idle';
      idleDays = connectedIdleDays;
      actions.push({
        kind: 'idle',
        instanceId,
        reason: `connected 超过 ${settings.desktopConnectedGraceHours}h 无活动`,
      });
    }

    // ② 账号被停用：立即回收，否则离职账号的桌面会一直占资源
    if (row.is_active === false) {
      const enqueued = await enqueueTask({
        taskKey: `recycle:instance:${instanceId}:disabled:${today}`,
        type: 'recycle',
        instanceId,
        userId,
      });
      if (enqueued.created) {
        actions.push({ kind: 'recycle', instanceId, reason: '账号已停用' });
      }
      continue;
    }

    // ③ 超过销毁线（idle 或已挂起都算）
    const destroyDays = asNum(row.destroy_limit, defaultDestroyDays);
    if (idleDays >= destroyDays) {
      const enqueued = await enqueueTask({
        taskKey: `recycle:instance:${instanceId}:${today}`,
        type: 'recycle',
        instanceId,
        userId,
      });
      if (enqueued.created) {
        actions.push({ kind: 'recycle', instanceId, reason: `空闲 ${Math.floor(idleDays)} 天 ≥ ${destroyDays}` });
      }
      continue;
    }

    // ④ VM 机龄到线 → 重建（换机周期，不是故障自愈）
    //
    // 三个限定：
    //  - `allow_rebuild=false` 直接跳过：入队也只会失败，还污染任务表；
    //  - `connected` 跳过：重建会把人踢下线，等他断开（降级 idle）后再来；
    //  - 机龄取**当前 VM** 的 created_at，不是实例的（见文件头）。
    const rebuildDays = asNum(row.rebuild_limit, DEFAULT_REBUILD_DAYS);
    const vmAgeDays = row.vm_age_days === null ? null : asNum(row.vm_age_days, 0);
    if (
      row.allow_rebuild !== false
      && status !== 'connected'
      && vmAgeDays !== null
      && vmAgeDays >= rebuildDays
    ) {
      const enqueued = await enqueueTask({
        taskKey: `rebuild:instance:${instanceId}:${today}`,
        type: 'rebuild',
        instanceId,
        userId,
      });
      if (enqueued.created) {
        actions.push({
          kind: 'rebuild',
          instanceId,
          reason: `VM 已运行 ${Math.floor(vmAgeDays)} 天 ≥ ${rebuildDays}`,
        });
      }
      continue;
    }

    // ⑤ 超过挂起线（idle / ready / awaiting_account 都算：
    //    创建后一直没用的桌面同样不该长期占内存；awaiting_account 是「建好了但用户还没登录过」，
    //    它此前完全不在扫描范围里 —— 漏掉就等于这类桌面永不被回收）
    const suspendDays = asNum(row.idle_limit, defaultSuspendDays);
    if (
      (status === 'idle' || status === 'ready' || status === 'awaiting_account')
      && idleDays >= suspendDays
    ) {
      const enqueued = await enqueueTask({
        taskKey: `suspend:instance:${instanceId}:${today}`,
        type: 'suspend',
        instanceId,
        userId,
      });
      if (enqueued.created) {
        actions.push({ kind: 'suspend', instanceId, reason: `空闲 ${Math.floor(idleDays)} 天 ≥ ${suspendDays}` });
      }
    }
  }

  return actions;
};

/* ---------------- 定时器（与 worker 同款：单例 + busy 锁） ---------------- */

export interface ReaperHandle {
  stop(): void;
}

let active: ReaperHandle | null = null;

export const startDesktopReaper = (intervalMs?: number): ReaperHandle => {
  if (active !== null) return active;

  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void sweepIdleInstances()
      .then((actions) => {
        if (actions.length > 0) {
          console.info('[desktop-reaper] 本轮处理 %s 个实例: %s', actions.length,
            actions.map((item) => `${item.instanceId}:${item.kind}`).join(','));
        }
      })
      .catch((error: unknown) => {
        console.error('[desktop-reaper] 扫描失败: %s', error);
      })
      .finally(() => { busy = false; });
  }, intervalMs ?? getSettings().desktopReaperIntervalMs);

  active = { stop: () => { clearInterval(timer); active = null; } };
  return active;
};

/** 测试钩子 */
export const resetDesktopReaper = (): void => {
  active?.stop();
  active = null;
};
