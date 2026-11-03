/**
 * 云桌面后台循环的启动入口 —— 从 bootstrap 调用
 *
 * 单独成文件的原因：worker / reaper 都会 setInterval 常驻，直接写在 bootstrap 里
 * 会让「跑一次迁移」这类一次性脚本也把定时器带上（进程不退出）。
 */
import { getSettings } from '../config/env.js';
import { startDesktopReaper } from '../desktop/reaper.js';
import { defaultHandlers } from '../desktop/tasks/index.js';
import { startDesktopWorker } from '../desktop/worker.js';

export const startDesktopWorkerLoop = (): void => {
  const {
    desktopEnabled, desktopWorkerEnabled, desktopWorkerIntervalMs, desktopWorkerBatch,
    desktopReaperEnabled, desktopReaperIntervalMs,
  } = getSettings();

  if (!desktopEnabled || !desktopWorkerEnabled) return;

  startDesktopWorker({
    handlers: defaultHandlers(),
    intervalMs: desktopWorkerIntervalMs,
    batch: desktopWorkerBatch,
  });
  console.info('[desktop-worker] 已启动（interval=%sms, batch=%s）',
    desktopWorkerIntervalMs, desktopWorkerBatch);

  // 回收扫描器与 worker 同生共死：没有 worker 时入队的任务没人执行，
  // 开着扫描器只会把 pending 堆起来，制造「任务堆积」的假告警。
  if (desktopReaperEnabled) {
    startDesktopReaper(desktopReaperIntervalMs);
    console.info('[desktop-reaper] 已启动（interval=%sms）', desktopReaperIntervalMs);
  }
};
