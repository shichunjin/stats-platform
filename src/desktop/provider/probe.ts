/**
 * TCP 探针 —— docs/multi-vm-desktop-plan.md 5.2 / 9.8
 *
 * 「VM 起来了」与「3389 能连」是两件事：Guest Agent 报 running 不代表
 * Remote Desktop 服务已监听（Windows 刚开机那几十秒 RDP 往往还没起）。
 * 用户点连接撞在这个窗口里，体验就是「打开一片黑屏然后断开」。
 *
 * 因此可用性判定以 **TCP 3389 可连** 为准，Agent 状态只作辅助。
 * 探测失败是业务结果而不是异常（`{ok:false}`），调用方据此计数自愈，
 * 不要 try/catch 成 500 —— 这与 `src/integrations/ssh-probe.ts` 的约定一致。
 */
import net from 'node:net';

export type TcpProbeResult =
  | { readonly ok: true; readonly latencyMs: number }
  | { readonly ok: false; readonly message: string };

/**
 * 探测 TCP 端口是否可连（纯连通性，不做协议握手）。
 *
 * 超时用 socket.setTimeout 而不是外层 Promise.race：后者在连接已建立、
 * 但对端不作答时会留下悬挂 socket（Node 进程退出被拖住）。
 */
export const probeTcp = (
  host: string,
  port: number,
  timeoutMs = 3_000,
): Promise<TcpProbeResult> => new Promise((resolve) => {
  const startedAt = Date.now();
  const socket = new net.Socket();
  let settled = false;

  const finish = (result: TcpProbeResult): void => {
    if (settled) return;
    settled = true;
    socket.destroy();
    resolve(result);
  };

  socket.setTimeout(timeoutMs);
  socket.once('connect', () => finish({ ok: true, latencyMs: Date.now() - startedAt }));
  socket.once('timeout', () => finish({ ok: false, message: `连接超时（${timeoutMs}ms）` }));
  socket.once('error', (error: Error) => finish({ ok: false, message: error.message }));
  socket.connect(port, host);
});
