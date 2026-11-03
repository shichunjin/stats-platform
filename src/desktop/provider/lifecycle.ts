/**
 * VM 生命周期小工具 —— 被 start 任务与「改密同步」共用
 *
 * 为什么单独成文件：`tasks/start.ts`（用户点连接唤醒）与
 * `service.syncVmAccount()`（改密时唤醒再同步账号）需要同一套
 * 「确保运行中」的语义。写两份必然在超时/幂等细节上分叉。
 */
import type { DesktopProvider } from './types.js';

export type EnsureRunningResult =
  | { readonly ok: true; readonly alreadyRunning: boolean }
  | { readonly ok: false; readonly reason: 'timeout' | 'still_stopped'; readonly lastPowerState: string };

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });

/**
 * 确保 VM 正在运行。
 *
 * - 已在运行 → 直接返回（`start` 对运行中的 VM 在 Proxmox 会返回错误，
 *   所以必须先 inspect 再决定要不要发 start，不能无脑 start）。
 * - 挂起（suspend to disk）后 PVE 报 `stopped`，`start` 会自动 resume，同一条路径处理。
 *
 * 轮询而不是固定 sleep：正常开机 20~40s，开机到一半就返回会让后续
 * TCP 探测必然失败、白记一次 probe_fail_count。
 */
export const ensureVmRunning = async (
  provider: DesktopProvider,
  ref: string,
  timeoutMs: number,
  pollIntervalMs = 3_000,
): Promise<EnsureRunningResult> => {
  const before = await provider.inspect(ref);
  if (before.powerState === 'running') return { ok: true, alreadyRunning: true };

  await provider.start(ref);

  const deadline = Date.now() + timeoutMs;
  let lastPowerState: string = before.powerState;
  for (;;) {
    const current = await provider.inspect(ref);
    lastPowerState = current.powerState;
    if (current.powerState === 'running') return { ok: true, alreadyRunning: false };
    if (Date.now() >= deadline) {
      return { ok: false, reason: 'timeout', lastPowerState };
    }
    await sleep(pollIntervalMs);
  }
};
