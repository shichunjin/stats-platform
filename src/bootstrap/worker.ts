/**
 * 云桌面 worker 的启动入口 —— 从 bootstrap 调用
 *
 * 单独成文件的原因：worker 会 setInterval 常驻，直接写在 bootstrap 里会让
 * 「跑一次迁移」这类一次性脚本也把定时器带上（进程不退出）。
 */
import { getSettings } from '../config/env.js';
import { defaultHandlers } from '../desktop/tasks/index.js';
import { startDesktopWorker } from '../desktop/worker.js';

export const startDesktopWorkerLoop = (): void => {
  const { desktopEnabled, desktopWorkerEnabled, desktopWorkerIntervalMs, desktopWorkerBatch }
    = getSettings();

  if (!desktopEnabled || !desktopWorkerEnabled) return;

  startDesktopWorker({
    handlers: defaultHandlers(),
    intervalMs: desktopWorkerIntervalMs,
    batch: desktopWorkerBatch,
  });
  console.info('[desktop-worker] 已启动（interval=%sms, batch=%s）',
    desktopWorkerIntervalMs, desktopWorkerBatch);
};
