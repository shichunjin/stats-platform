/**
 * 任务队列 + worker —— docs/multi-vm-desktop-plan.md 7.8 / 6.5
 *
 * 锁的是「进程重启不丢任务」这条底线：
 *  - 入队幂等（task_key 冲突不重复建）
 *  - SKIP LOCKED 取任务：未到期不取、已取的不重复取
 *  - 失败退避与重试上限：未达上限回 pending，达上限进 failed（终态）
 *  - worker 分发：异常必须写回任务表，绝不能冒泡成 unhandledRejection
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetSettings } from '../../src/config/env.js';
import { desktopTasks } from '../../src/db/schema.js';
import { withSession } from '../../src/db/session.js';
import {
  claimNextTask, completeTask, enqueueTask, failTask, queueDepth, type ClaimedTask,
} from '../../src/desktop/queue.js';
import { resetDesktopWorker, runDueTasks, type HandlerMap } from '../../src/desktop/worker.js';
import { resetDatabase } from './setup.js';

const findTask = async (taskKey: string) => withSession(async (db) => {
  const [row] = await db.db.select().from(desktopTasks)
    .where(eq(desktopTasks.taskKey, taskKey)).limit(1);
  return row ?? null;
});

beforeEach(resetDatabase);
afterEach(() => {
  resetSettings();
  resetDesktopWorker();
});

describe('入队（幂等）', () => {
  it('同 task_key 只建一条任务', async () => {
    const first = await enqueueTask({ taskKey: 'create:instance:1', type: 'create' });
    const second = await enqueueTask({ taskKey: 'create:instance:1', type: 'create' });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.id).toBe(0);
  });

  it('不同 task_key 互不影响', async () => {
    await enqueueTask({ taskKey: 'a', type: 'create' });
    await enqueueTask({ taskKey: 'b', type: 'create' });
    expect((await queueDepth()).pending).toBe(2);
  });

  it('delayMs 会推迟可取时间（未到期取不到）', async () => {
    await enqueueTask({ taskKey: 'later', type: 'create', delayMs: 60_000 });
    expect(await claimNextTask()).toBeNull();
  });
});

describe('取任务与收尾', () => {
  it('claim 后 attempts+1 且状态转 running；重复 claim 取不到', async () => {
    await enqueueTask({ taskKey: 'k', type: 'create' });

    const claimed = await claimNextTask();
    expect(claimed).not.toBeNull();
    expect(claimed!.attempts).toBe(1);
    expect(await claimNextTask()).toBeNull();

    const row = await findTask('k');
    expect(row?.status).toBe('running');
  });

  it('complete 置 success', async () => {
    await enqueueTask({ taskKey: 'k', type: 'create' });
    const claimed = await claimNextTask();
    await completeTask(claimed!.id);
    expect((await findTask('k'))?.status).toBe('success');
  });

  it('未达重试上限：回 pending 并推迟 not_before', async () => {
    await enqueueTask({ taskKey: 'k', type: 'create', maxAttempts: 3 });
    const claimed = await claimNextTask();

    await failTask(claimed!.id, new Error('boom'));

    const row = await findTask('k');
    expect(row?.status).toBe('pending');
    expect(row?.errorMessage).toContain('boom');
    expect(row?.notBefore).not.toBeNull();
    expect(row?.notBefore!.getTime()).toBeGreaterThan(Date.now() - 1_000);
  });

  it('达到重试上限：进 failed 终态（不再被取到）', async () => {
    await enqueueTask({ taskKey: 'k', type: 'create', maxAttempts: 1 });
    const claimed = await claimNextTask();
    await failTask(claimed!.id, new Error('fatal'));

    const row = await findTask('k');
    expect(row?.status).toBe('failed');
    expect(row?.finishedAt).not.toBeNull();
    expect(await claimNextTask()).toBeNull();
  });

  it('错误消息超长会被截断（Proxmox 出错可能返回整页 HTML）', async () => {
    await enqueueTask({ taskKey: 'k', type: 'create', maxAttempts: 1 });
    const claimed = await claimNextTask();
    await failTask(claimed!.id, 'x'.repeat(5_000));

    const row = await findTask('k');
    expect(row?.errorMessage?.length).toBe(2_000);
  });
});

describe('worker 分发', () => {
  const handlers = (impl: () => Promise<void>): HandlerMap => ({ create: async () => impl() });

  it('handler 成功 → 任务 success', async () => {
    await enqueueTask({ taskKey: 'k', type: 'create' });
    const seen: ClaimedTask[] = [];

    const summary = await runDueTasks({
      handlers: { create: async (task) => { seen.push(task); } },
    });

    expect(summary).toEqual({ claimed: 1, succeeded: 1, failed: 0 });
    expect(seen[0]?.taskKey).toBe('k');
    expect((await findTask('k'))?.status).toBe('success');
  });

  it('handler 抛错 → 记 failed/退避，不冒泡', async () => {
    await enqueueTask({ taskKey: 'k', type: 'create', maxAttempts: 1 });

    const summary = await runDueTasks({ handlers: handlers(async () => { throw new Error('nope'); }) });

    expect(summary.failed).toBe(1);
    expect((await findTask('k'))?.status).toBe('failed');
  });

  it('未注册的类型 → 失败并留下可读错误码，而不是静默卡住', async () => {
    await enqueueTask({ taskKey: 'k', type: 'destroy', maxAttempts: 1 });

    await runDueTasks({ handlers: { create: async () => undefined } });

    expect((await findTask('k'))?.errorMessage).toContain('未注册的任务处理器');
  });

  it('空队列返回 0，不抛错', async () => {
    expect(await runDueTasks({ handlers: {} })).toEqual({ claimed: 0, succeeded: 0, failed: 0 });
  });

  it('batch 限制单轮处理条数', async () => {
    await enqueueTask({ taskKey: 'a', type: 'create' });
    await enqueueTask({ taskKey: 'b', type: 'create' });

    const summary = await runDueTasks({ handlers: handlers(async () => undefined), batch: 1 });
    expect(summary.claimed).toBe(1);
    expect((await queueDepth()).pending).toBe(1);
  });

  /**
   * 只用真实定时器验证「重复调用返回同一句柄」—— 不推进时间。
   * 用 vi.useFakeTimers() 推时间会把 PGlite 的 IO 一起冻住（await 永不返回），
   * 那是测试环境的坑，不是 worker 的问题。
   */
  it('startDesktopWorker 幂等：重复调用返回同一句柄，stop 后可再启动', async () => {
    const { startDesktopWorker } = await import('../../src/desktop/worker.js');
    const first = startDesktopWorker({ handlers: handlers(async () => undefined), intervalMs: 60_000 });
    const second = startDesktopWorker({ handlers: handlers(async () => undefined), intervalMs: 60_000 });
    expect(second).toBe(first);

    first.stop();
    const third = startDesktopWorker({ handlers: handlers(async () => undefined), intervalMs: 60_000 });
    expect(third).not.toBe(first);
    third.stop();
  });
});
