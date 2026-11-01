/**
 * 连通性探测 —— app/routers/admin.py 的 `POST /admin/platform/test`
 *
 * Python 侧在函数体内 `import paramiko` 现连现断；这里抽成独立模块，
 * 因为它跟 transfer.ts 的「密钥免密 + 长连接」是两种完全不同的连接形态：
 * 探测用管理员临时输入的密码，且必须每次新建/销毁。
 *
 * 返回值用判别联合而非抛异常：探测失败是**预期内的业务结果**（要写审计日志 + 502），
 * 不是程序错误，不该混进 error 通道。
 */
import { Client as SshClient } from 'ssh2';

const DEFAULT_TIMEOUT_MS = 8_000;

export interface SshProbeOptions {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly password: string;
  readonly timeoutMs?: number;
}

export type SshProbeOutcome =
  | { readonly ok: true; readonly latencyMs: number }
  | { readonly ok: false; readonly message: string };

interface SshProbeError extends Error {
  readonly level?: string;
  readonly code?: string;
}

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'ENETUNREACH',
  'ENETDOWN',
  'EADDRNOTAVAIL',
]);

const describe = (error: SshProbeError): string => error.message || String(error);

/**
 * 建立一次 SSH 连接并认证，返回耗时或面向管理员的错误说明。
 *
 * 与 paramiko 的差异：
 * - paramiko 用 `AutoAddPolicy` 静默信任未知主机指纹；ssh2 没有等价开关，
 *   这里用 hostVerifier 复现同样行为，并保留告警（已知弱点，见 transfer.ts 注释）
 * - paramiko 的 `socket.timeout` / `AuthenticationException` 是异常类型，
 *   ssh2 只有 `err.level`，因此靠 level 分类而非 instanceof
 */
export const probeSshConnection = async (
  options: SshProbeOptions,
): Promise<SshProbeOutcome> => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const target = `${options.host}:${options.port}`;
  const ssh = new SshClient();
  const startedAt = Date.now();

  const outcome = await new Promise<SshProbeOutcome>((resolve) => {
    let settled = false;
    const finish = (result: SshProbeOutcome): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    ssh.once('ready', () => {
      finish({ ok: true, latencyMs: Date.now() - startedAt });
    });

    ssh.once('error', (error: SshProbeError) => {
      if (error.level === 'client-authentication') {
        finish({ ok: false, message: '认证失败：用户名或密码错误' });
        return;
      }
      if (error.level === 'client-timeout' || error.code === 'ETIMEDOUT') {
        finish({
          ok: false,
          message: `连接超时：无法在 ${timeoutMs / 1000} 秒内连上 ${target}，请检查地址/端口/防火墙`,
        });
        return;
      }
      if (error.code !== undefined && NETWORK_CODES.has(error.code)) {
        finish({ ok: false, message: `网络错误：${describe(error)}` });
        return;
      }
      finish({ ok: false, message: `连接失败：${describe(error)}` });
    });

    try {
      ssh.connect({
        host: options.host,
        port: options.port,
        username: options.username,
        password: options.password,
        readyTimeout: timeoutMs,
        agentForward: false,
        // 等价 paramiko 的 allow_agent=False / look_for_keys=False
        tryKeyboard: false,
        hostVerifier: (key: Buffer) => {
          console.warn('[ssh-probe] 首次连接主机，已自动信任其指纹（未启用 known_hosts 校验）');
          return key.length > 0;
        },
      });
    } catch (error) {
      finish({ ok: false, message: `连接失败：${describe(error as SshProbeError)}` });
    }
  });

  // paramiko 的 finally: client.close()；ssh2 的 end() 会立刻断开底层 socket
  ssh.end();
  return outcome;
};
