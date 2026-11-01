/**
 * 后台任务执行器 —— app/jobs.py（性能修复 C1）
 *
 * ⚠️ 与 Python 的架构差异：
 *   Python 用 ThreadPoolExecutor（max_workers=2），阻塞型 IO 与 CPU 都能丢进线程池。
 *   Node 是单线程事件循环 —— **异步 IO 不阻塞，但 CPU 密集的 Excel 生成会阻塞整个
 *   进程**。因此这里给出两条路径：
 *     1. `submitGenerate`：进程内异步队列（并发上限 2），适合 IO 为主的任务
 *     2. `submitGenerateInWorker`：**生产推荐**，把任务放进 worker_threads，
 *        Excel 生成不占事件循环（worker 内需自建 pg Pool，Pool 不能跨线程共享）
 *
 * 两者的 in-flight 语义与 Python 一致：同一 apply_id 已有任务在跑则返回 false。
 */
import { Worker } from 'node:worker_threads';

const MAX_CONCURRENCY = 2;

const inflight = new Set<number>();
let running = 0;
const queue: (() => Promise<void>)[] = [];

const drain = (): void => {
  while (running < MAX_CONCURRENCY && queue.length > 0) {
    const task = queue.shift();
    if (!task) break;
    running += 1;
    void task().finally(() => {
      running -= 1;
      drain();
    });
  }
};

export interface SubmitOptions {
  /** 用 worker_threads 承载 CPU 密集部分（生产推荐） */
  readonly worker?: {
    readonly filename: string;
    readonly workerData: Record<string, unknown>;
  };
}

/** 提交生成任务；同一申请已有任务在跑时返回 false（防并发双击/重试风暴） */
export const submitGenerate = (
  applyId: number,
  task: () => Promise<void>,
  options: SubmitOptions = {},
): boolean => {
  if (inflight.has(applyId)) return false;
  inflight.add(applyId);

  const runner = async (): Promise<void> => {
    try {
      if (options.worker) {
        await runInWorker(options.worker.filename, { ...options.worker.workerData, applyId });
      } else {
        await task();
      }
    } catch (error) {
      console.error('[jobs] 后台生成任务未捕获异常 apply_id=%s: %s', applyId, error);
    } finally {
      inflight.delete(applyId);
    }
  };

  queue.push(runner);
  drain();
  return true;
};

const runInWorker = (
  filename: string,
  workerData: Record<string, unknown>,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const worker = new Worker(filename, { workerData });
    worker.on('error', reject);
    worker.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`worker 退出码 ${code}`));
    });
  });

/** 该申请当前是否有任务在跑（区分「生成中」与进程重启残留的 stale 状态） */
export const isInflight = (applyId: number): boolean => inflight.has(applyId);

/** 测试用 */
export const resetJobs = (): void => {
  inflight.clear();
  queue.length = 0;
  running = 0;
};
