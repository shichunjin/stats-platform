/**
 * 进程入口 —— app/main.py 的 `if __name__ == "__main__": uvicorn.run(...)`
 *
 * Python 用 `uvicorn.run(reload=True)`：reload 是开发期行为，生产由 systemd/gunicorn
 * 管。Node 侧同理：开发用 `npm run dev`（tsx watch），生产用 `npm start`（node dist）。
 */
import { getSettings } from './config/env.js';
import { buildApp, shutdown } from './server.js';

const DEFAULT_PORT = 8000;

const resolvePort = (): number => {
  const raw = process.env.PORT;
  if (raw === undefined || raw.trim() === '') return DEFAULT_PORT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new Error(`PORT 必须是 1-65535 的整数，当前值: ${raw}`);
  }
  return parsed;
};

const start = async (): Promise<void> => {
  // 先触发配置加载（fail-fast 放在监听之前，避免「端口已开但配置非法」）
  getSettings();

  const app = await buildApp();
  const port = resolvePort();

  const stop = async (signal: NodeJS.Signals): Promise<void> => {
    app.log.info({ signal }, '收到停止信号，开始优雅停机');
    await shutdown(app);
    process.exit(0);
  };
  process.once('SIGINT', () => void stop('SIGINT'));
  process.once('SIGTERM', () => void stop('SIGTERM'));

  try {
    await app.listen({ host: '0.0.0.0', port });
  } catch (error) {
    app.log.error(error);
    await shutdown(app).catch(() => undefined);
    process.exit(1);
  }
};

void start();
