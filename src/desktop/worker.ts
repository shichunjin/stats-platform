/**
 * 任务 worker —— docs/multi-vm-desktop-plan.md 6.5
 *
 * 为什么是「同进程 setInterval」而不是独立服务：
 * 平台只有一个 Node 进程（部署形态见 README），把它拆成独立服务要额外解决
 * 鉴权、配置同步、CORS（server.ts 的 PROD_CORS_ORIGINS 是硬编码）三件事，
 * 而单进程恰好**天然保证 worker 唯一**（不需要选主）。
 *
 * 幂等与幂等键：任务由 `task_key` 去重（queue.ts），worker 只负责「取 → 执行 → 收尾」；
 * 执行体必须自己保证可重入（例如 create 先查是否已有 VM）。
 */
import { getSettings } from '../config/env.js';
import type { DesktopTaskType } from '../db/schema.js';
import { claimNextTask, completeTask, failTask, type ClaimedTask } from './queue.js';

export type TaskHandler = (task: ClaimedTask) => Promise<void>;

export type HandlerMap = Readonly<Partial<Record<DesktopTaskType, TaskHandler>>>;

export interface RunSummary {
  readonly claimed: number;
  readonly succeeded: number;
  readonly failed: number;
}

/** 没有注册 handler 的类型：直接判失败并留错误码，避免任务静默卡在 running */
const noHandler = async (task: ClaimedTask): Promise<never> => {
  throw new Error(`未注册的任务处理器: type=${task.type}`);
};

export interface RunOnceOptions {
  readonly handlers: HandlerMap;
  /** 单轮最多处理多少条（防长任务饿死事件循环） */
  readonly batch?: number;
}

/**
 * 跑一轮：取任务 → 分发 → 收尾。
 *
 * ⚠️ 单个任务的异常必须在这里消化掉（写回 failed/退避），绝不能冒泡：
 * 冒泡会让 setInterval 的回调变成 unhandledRejection，后续轮次全部停摆。
 */
export const runDueTasks = async (options: RunOnceOptions): Promise<RunSummary> => {
  const batch = options.batch ?? 1;
  let claimed = 0;
  let succeeded = 0;
  let failed = 0;

  for (let index = 0; index < batch; index += 1) {
    const task = await claimNextTask();
    if (task === null) break;
    claimed += 1;

    const handler = options.handlers[task.type] ?? noHandler;
    try {
      await handler(task);
      await completeTask(task.id);
      succeeded += 1;
    } catch (error) {
      failed += 1;
      console.error(
        '[desktop-worker] 任务失败 id=%s key=%s type=%s attempt=%s/%s: %s',
        task.id, task.taskKey, task.type, task.attempts, task.maxAttempts, error,
      );
      await failTask(task.id, error).catch((failError: unknown) => {
        console.error('[desktop-worker] 写回失败状态也失败了 id=%s: %s', task.id, failError);
      });
    }
  }

  return { claimed, succeeded, failed };
};

export interface WorkerOptions extends RunOnceOptions {
  readonly intervalMs?: number;
}

export interface WorkerHandle {
  stop(): void;
  readonly running: boolean;
}

let active: WorkerHandle | null = null;

/**
 * 启动常驻 worker。重复调用返回同一句柄（幂等），避免多处启动导致并发超标。
 *
 * 用一把 `busy` 锁：上一轮没跑完就跳过本轮。setInterval 不会因为回调是 async 而等待，
 * 少了这把锁，慢任务（克隆 VM 要几分钟）会叠加成并发风暴。
 */
export const startDesktopWorker = (options: WorkerOptions): WorkerHandle => {
  if (active !== null) return active;

  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void runDueTasks(options)
      .catch((error: unknown) => {
        console.error('[desktop-worker] 本轮执行异常: %s', error);
      })
      .finally(() => { busy = false; });
  }, options.intervalMs ?? getSettings().desktopWorkerIntervalMs);

  const handle: WorkerHandle = {
    stop: () => {
      clearInterval(timer);
      active = null;
    },
    get running(): boolean {
      return busy;
    },
  };
  active = handle;
  return handle;
};

/** 测试钩子 */
export const resetDesktopWorker = (): void => {
  active?.stop();
  active = null;
};
