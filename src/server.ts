/**
 * Fastify 应用工厂 —— app/main.py
 *
 * 与 FastAPI 的结构差异：
 *  - `Depends(get_db)`      → `app.decorate('withDb')` + 请求级事务会话（plugins/db.ts）
 *  - `APIRouter(prefix=..)` → FastifyPluginAsync 里直接写全路径（前缀写在路径里更直观，
 *                            也避免插件封装带来的 hook 顺序困惑）
 *  - `@app.middleware`      → `addHook('onSend')` / `addHook('onRequest')`
 *  - `StaticFiles`          → `@fastify/static`
 *  - 自动生成的 /docs       → `@fastify/swagger` + `@fastify/swagger-ui`（仅 dev）
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import { httpErrorHandler } from './auth/guards.js';
import { getSettings } from './config/env.js';
import { closeDatabase } from './db/client.js';
import { disposeGuacPool } from './integrations/guac.js';
import { dbPlugin } from './plugins/db.js';
import { adminRoutes } from './routers/admin.js';
import { appliesRoutes } from './routers/applies.js';
import { authRoutes } from './routers/auth.js';
import { dataRoutes } from './routers/data.js';
import { messageRoutes } from './routers/messages.js';
import { resultsRoutes } from './routers/results.js';
import { sessionRoutes } from './routers/session.js';

/**
 * 定位仓库根目录。
 *
 * 开发与构建两种运行态的层级不一样，写死 `..` 只能在其中一种下正确：
 *   - `tsx src/index.ts`        → src/server.ts，上 1 级即根
 *   - `node dist/src/server.js` → dist/src/server.js，上 2 级才是根
 * （曾因写死 `..` 导致构建态解析出 dist/app/static/login.html，/login 全量 500）
 *
 * 因此改为从本文件所在目录逐级向上找 package.json，两种布局都能命中。
 */
export const findRepoRoot = (startDir: string): string => {
  let dir = startDir;
  // 最多向上 6 级：正常 1-2 级就能命中，限制深度是为了目录异常时快速失败而不是死循环
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return startDir;
};

const REPO_ROOT = findRepoRoot(resolve(fileURLToPath(new URL('.', import.meta.url))));
const FRONTEND_DIST = join(REPO_ROOT, 'frontend', 'dist');
const SPA_INDEX = join(FRONTEND_DIST, 'index.html');
/** 旧版静态页面（未构建 Vue 产物时的兜底），沿用 Python 的位置 app/static */
const LEGACY_STATIC_DIR = join(REPO_ROOT, 'app', 'static');

/**
 * 安全修复 C4：Content-Security-Policy 等安全响应头。
 * Token 存 localStorage 的现状下，CSP 是 XSS 窃取令牌的纵深防御。
 */
const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
    + "img-src 'self' data:; font-src 'self' data:; connect-src 'self'; "
    + "frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
};

/** 安全修复 B11：生产环境关闭公开 API 文档，不向未认证用户暴露完整攻击面 */
const isProd = (): boolean => getSettings().appEnv === 'prod';

const PROD_CORS_ORIGINS: readonly string[] = [
  'https://chunjindevelop68.xyz',
  'https://www.chunjindevelop68.xyz',
  'https://guac.chunjindevelop68.xyz',
];

const DEV_CORS_ORIGINS: readonly string[] = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];

/**
 * 旧版静态页面（app/static/*.html）。
 * 缺文件时返回 503 + 明确文案，而不是让 readFileSync 抛 ENOENT —— 后者在日志里
 * 只是一串堆栈，看不出到底是前端没构建还是路径算错了。
 */
const sendLegacyPage = (reply: FastifyReply, name: string): FastifyReply => {
  const filePath = join(LEGACY_STATIC_DIR, name);
  if (!existsSync(filePath)) {
    return reply.code(503).type('text/plain').send(
      `静态页面缺失：${filePath}。请先构建前端（frontend/dist/index.html），`
      + '或确认仓库里存在 app/static/',
    );
  }
  return reply.type('text/html').send(readFileSync(filePath, 'utf8'));
};

export interface BuildOptions {
  /** 测试用：跳过迁移/演示数据，只装配路由 */
  readonly skipBootstrap?: boolean;
  /** 传 false 完全关闭 HTTP 日志（测试用：否则每个请求一条 info 日志，会淹没断言失败） */
  readonly logger?: boolean;
}

export const buildApp = async (options: BuildOptions = {}): Promise<FastifyInstance> => {
  const app = Fastify({
    logger: options.logger === false ? false : { level: isProd() ? 'info' : 'debug' },
    // 与 Python 一致的「单 worker」语义由部署层保证（见 README）
    bodyLimit: 1_048_576,
  });

  app.setErrorHandler(httpErrorHandler);

  // ---- 安全响应头（onSend 而非 onRequest：只给真正产生的响应加头） ----
  // ⚠️ onSend 必须原样返回 payload；返回 reply 会把响应体替换成 reply 对象本身，
  // 导致序列化卡死（表现为请求永远不返回）
  app.addHook('onSend', async (_request, reply, payload) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      // FastifyReply 是 thenable，直接丢弃返回值会被 no-floating-promises 判为
      // 未处理的 Promise，显式 void
      if (!reply.hasHeader(name)) void reply.header(name, value);
    }
    return payload;
  });

  await app.register(cors, {
    origin: isProd() ? [...PROD_CORS_ORIGINS] : [...PROD_CORS_ORIGINS, ...DEV_CORS_ORIGINS],
    credentials: true,
  });

  // ---- OpenAPI 文档（仅 dev）----
  if (!isProd()) {
    await app.register(fastifySwagger, {
      openapi: {
        info: {
          title: '统计软件托管平台',
          version: '1.0.0',
          description: '在「不修改无源码 Windows 桌面软件」的前提下，让用户通过浏览器使用 Windows 分析主机上的桌面软件。',
        },
        tags: [
          { name: '认证', description: '用户登录与身份验证相关接口' },
          { name: '用户', description: '用户信息查询接口' },
          { name: '会话', description: '远程统计软件会话管理接口' },
          { name: '结果', description: '分析结果审查与下载接口' },
          { name: '管理员', description: '管理员专属接口（需管理员权限）' },
        ],
      },
    });
    await app.register(fastifySwaggerUi, { routePrefix: '/docs' });
  }

  await app.register(dbPlugin);
  await app.register(authRoutes);
  await app.register(sessionRoutes);
  await app.register(resultsRoutes);
  await app.register(adminRoutes);
  await app.register(dataRoutes);
  await app.register(messageRoutes);
  await app.register(appliesRoutes);

  app.get('/health', async () => ({ status: 'ok' }));

  // ---- 前端托管 ----
  if (existsSync(SPA_INDEX)) {
    // hashed 静态资源（assets/*）与 dist 根目录真实文件（favicon.ico）由插件直出
    await app.register(fastifyStatic, { root: FRONTEND_DIST, prefix: '/' });

    // history 模式回退：仅对「整页导航」生效（Accept 含 text/html）。
    // axios 请求不带 text/html，会正常落到 API 路由，不会误命中这里。
    app.setNotFoundHandler(async (request, reply) => {
      const accept = request.headers.accept ?? '';
      // B11：docs/redoc/openapi 在生产未注册，落入回退时必须 404 而不是返回 SPA
      const segment = request.url.split('?')[0]!.split('/')[1] ?? '';
      if (segment === 'docs' || segment === 'redoc' || segment === 'openapi.json') {
        return reply.code(404).send({ detail: 'Not Found' });
      }
      if (request.method === 'GET' && accept.includes('text/html')) {
        return reply.type('text/html').sendFile('index.html');
      }
      return reply.code(404).send({ detail: 'Not Found' });
    });
  } else {
    // 未构建前端时的兜底：旧版静态页面 + 根路径服务信息
    if (!existsSync(LEGACY_STATIC_DIR)) {
      app.log.warn(
        { frontendDist: FRONTEND_DIST, legacyStatic: LEGACY_STATIC_DIR },
        '前端产物与旧版静态页都不存在，/login 与 /dashboard 将返回 503',
      );
    }
    await app.register(fastifyStatic, { root: LEGACY_STATIC_DIR, prefix: '/static' });

    app.get('/', async () => ({
      service: '统计软件托管平台',
      docs: '/docs',
      login_page: '/login',
      endpoints: {
        register: 'POST /auth/register',
        login: 'POST /auth/login',
        me: 'GET /auth/me',
        connect: 'POST /session/connect',
        fetch_data: 'POST /data/fetch',
        my_results: 'GET /results/mine',
        request_export: 'POST /results/request-export',
        download: 'POST /results/{id}/download',
        audit: 'GET /admin/audit',
      },
    }));

    // 文件缺失时给 503 + 明确文案，而不是让 readFileSync 抛 ENOENT 变成一堆堆栈的 500
    app.get('/login', (_request, reply) => sendLegacyPage(reply, 'login.html'));
    app.get('/dashboard', (_request, reply) => sendLegacyPage(reply, 'dashboard.html'));
  }

  if (options.skipBootstrap !== true) {
    // 延迟导入：bootstrap 会建池并连库，测试环境下不该在 buildApp 里触发
    const { bootstrap } = await import('./bootstrap/index.js');
    await bootstrap();
  }

  return app;
};

/** 优雅停机：先停 HTTP，再关连接池（Guacamole / PostgreSQL） */
export const shutdown = async (app: FastifyInstance): Promise<void> => {
  await app.close();
  await disposeGuacPool();
  await closeDatabase();
};
