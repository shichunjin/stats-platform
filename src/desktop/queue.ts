/**
 * 任务队列 —— docs/multi-vm-desktop-plan.md 7.8 / 6.5
 *
 * 为什么不用内存队列：`src/services/jobs.ts` 那套（Set + 数组）进程重启即丢，
 * 而创建一台 VM 要几分钟，重启丢任务的代价是「用户点连接后永远卡在 provisioning」。
 * 这里改用 PostgreSQL 自身做队列：`FOR UPDATE SKIP LOCKED` 取任务，
 * 状态与重试计数落 `desktop_tasks`，worker 重启后从库里接着跑。
 *
 * 并发模型：**不引入 Redis/MQ**（方案 Q10 默认）。单 Node 进程 = 单 worker，
 * SKIP LOCKED 只是给「未来多副本 / 手动补跑脚本」留的安全边界。
 */
import { sql } from 'drizzle-orm';
import { getSettings } from '../config/env.js';
import type { DesktopTaskType } from '../db/schema.js';
import { withSession } from '../db/session.js';

/** drizzle 的 execute 在 node-postgres 下返回 pg 的 QueryResult；此处只用到 rows */
interface RowsLike<T> {
  readonly rows: readonly T[];
}

const rowsOf = <T>(result: unknown): readonly T[] => (result as RowsLike<T>).rows ?? [];

export interface EnqueueInput {
  /** 幂等键，重复入队直接命中已有任务（防用户连点 / 重试风暴） */
  readonly taskKey: string;
  readonly type: DesktopTaskType;
  readonly instanceId?: number | null;
  readonly vmId?: number | null;
  readonly userId?: number | null;
  /** 入参摘要：必须脱敏，禁止存密码 */
  readonly requestJson?: Readonly<Record<string, unknown>> | null;
  readonly maxAttempts?: number;
  /** 延迟执行（毫秒）：默认立即可取 */
  readonly delayMs?: number;
}

export interface EnqueueResult {
  readonly id: number;
  /** false = 已有同 taskKey 的任务（幂等命中），未重复创建 */
  readonly created: boolean;
}

/**
 * 入队（幂等）。
 *
 * `ON CONFLICT (task_key) DO NOTHING` 后若没有 RETURNING 行，说明已存在 ——
 * 这时**不能**再查一次并返回旧 id 之外的东西：调用方（/desktop/ensure）需要
 * 明确的「是不是我建的」，以便决定是否写审计。
 */
export const enqueueTask = async (input: EnqueueInput): Promise<EnqueueResult> =>
  withSession(async (db) => {
    const result = await db.db.execute(sql`
      INSERT INTO desktop_tasks
        (task_key, type, instance_id, vm_id, user_id, request_json, max_attempts, not_before, created_at)
      VALUES (
        ${input.taskKey}, ${input.type},
        ${input.instanceId ?? null}, ${input.vmId ?? null}, ${input.userId ?? null},
        ${input.requestJson === undefined || input.requestJson === null
    ? null
    : JSON.stringify(input.requestJson)}::jsonb,
        ${input.maxAttempts ?? 3},
        now() + make_interval(secs => ${Math.max(0, Math.floor((input.delayMs ?? 0) / 1000))}),
        now()
      )
      ON CONFLICT (task_key) DO NOTHING
      RETURNING id
    `);

    const rows = rowsOf<{ id: string | number }>(result);
    await db.commit();

    if (rows.length === 0) return { id: 0, created: false };
    return { id: Number(rows[0]!.id), created: true };
  });

export interface ClaimedTask {
  readonly id: number;
  readonly taskKey: string;
  readonly type: DesktopTaskType;
  readonly instanceId: number | null;
  readonly vmId: number | null;
  readonly userId: number | null;
  /** 已尝试次数（本次 claim 时已 +1） */
  readonly attempts: number;
  readonly maxAttempts: number;
  /**
   * 入参摘要（脱敏后的 JSON）。handler 靠它拿「创建时决定的东西」—— 例如 IPAM 分配的
   * 静态 IP：那些值不属于任何表的列，重新推导既麻烦又可能与当时不一致。
   */
  readonly requestJson: Readonly<Record<string, unknown>> | null;
}

interface ClaimRow {
  readonly id: string | number;
  readonly task_key: string;
  readonly type: string;
  readonly instance_id: number | null;
  readonly vm_id: number | null;
  readonly user_id: number | null;
  readonly attempts: number;
  readonly max_attempts: number;
  readonly request_json: Readonly<Record<string, unknown>> | null;
}

/**
 * 取一条到期任务并标记为 running。
 *
 * `FOR UPDATE SKIP LOCKED` 让多个消费者不互相阻塞；CTE 只锁 id 再回写，
 * 是为了让 LIMIT 与 UPDATE 作用在同一批行上（直接 UPDATE ... WHERE 条件下
 * FOR UPDATE SKIP LOCKED 在 PostgreSQL 里不允许，必须走 CTE）。
 */
export const claimNextTask = async (): Promise<ClaimedTask | null> =>
  withSession(async (db) => {
    const result = await db.db.execute(sql`
      WITH next AS (
        SELECT id FROM desktop_tasks
        WHERE status = 'pending' AND not_before <= now()
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE desktop_tasks
      SET status = 'running', started_at = now(), attempts = attempts + 1
      WHERE id IN (SELECT id FROM next)
      RETURNING id, task_key, type, instance_id, vm_id, user_id, attempts, max_attempts, request_json
    `);

    const rows = rowsOf<ClaimRow>(result);
    await db.commit();

    if (rows.length === 0) return null;
    const row = rows[0]!;
    return {
      id: Number(row.id),
      taskKey: row.task_key,
      type: row.type as DesktopTaskType,
      instanceId: row.instance_id,
      vmId: row.vm_id,
      userId: row.user_id,
      attempts: Number(row.attempts),
      maxAttempts: Number(row.max_attempts),
      requestJson: row.request_json,
    };
  });

/** 成功收尾 */
export const completeTask = async (id: number): Promise<void> => {
  await withSession(async (db) => {
    await db.db.execute(sql`
      UPDATE desktop_tasks
      SET status = 'success', progress = 100, stage = 'done',
          error_code = NULL, error_message = NULL, finished_at = now()
      WHERE id = ${id}
    `);
    await db.commit();
  });
};

/** 失败重试上限（毫秒）：再长就没意义了，交给人工工单 */
const MAX_BACKOFF_MS = 60_000;

/**
 * 失败收尾：未达上限 → 退回 pending 并按指数退避推迟；达上限 → failed（终态）。
 *
 * 错误消息截断到 2000 字符：Proxmox 出错时可能返回整页 HTML，直接落库会撑爆 text 列。
 */
export const failTask = async (
  id: number,
  error: unknown,
  options: { readonly errorCode?: string } = {},
): Promise<void> => {
  const message = String(error instanceof Error ? error.message : error).slice(0, 2_000);
  const { desktopRetryBackoffMs } = getSettings();

  await withSession(async (db) => {
    const result = await db.db.execute(sql`
      UPDATE desktop_tasks
      SET status = CASE WHEN attempts >= max_attempts THEN 'failed'::varchar ELSE 'pending'::varchar END,
          stage = 'failed',
          error_code = ${options.errorCode ?? null},
          error_message = ${message},
          not_before = now() + make_interval(secs => ${Math.floor(
    Math.min(MAX_BACKOFF_MS, desktopRetryBackoffMs) / 1000,
  )}),
          finished_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END
      WHERE id = ${id}
      RETURNING attempts, max_attempts
    `);

    const rows = rowsOf<{ attempts: number; max_attempts: number }>(result);
    const row = rows[0];
    if (row && Number(row.attempts) < Number(row.max_attempts)) {
      // 指数退避：base * 2^(attempts-1)，上限 60s。attempts 已在 claim 时 +1
      const exponent = Math.max(0, Number(row.attempts) - 1);
      const delaySec = Math.floor(Math.min(MAX_BACKOFF_MS, desktopRetryBackoffMs * 2 ** exponent) / 1000);
      await db.db.execute(sql`
        UPDATE desktop_tasks
        SET not_before = now() + make_interval(secs => ${delaySec})
        WHERE id = ${id}
      `);
    }
    await db.commit();
  });
};

/** 队列水位（P0 告警用：pending 长时间堆积说明 worker 挂了） */
export const queueDepth = async (): Promise<{ pending: number; running: number; failed: number }> =>
  withSession(async (db) => {
    const result = await db.db.execute(sql`
      SELECT
        count(*) FILTER (WHERE status = 'pending')::int AS pending,
        count(*) FILTER (WHERE status = 'running')::int AS running,
        count(*) FILTER (WHERE status = 'failed')::int   AS failed
      FROM desktop_tasks
    `);
    const rows = rowsOf<{ pending: number; running: number; failed: number }>(result);
    return rows[0] ?? { pending: 0, running: 0, failed: 0 };
  });
