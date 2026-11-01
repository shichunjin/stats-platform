/**
 * 数据投递通道回归测试 —— tests/test_data_fetch.py
 *
 * 与 Python 的几处差异（都写在注释里，避免后人误以为是漏测）：
 *  1. Python 用 monkeypatch 换 `data_routes.upload_file_to_windows` /
 *     `generate_filtered_excel_from_table`（模块内的 import 绑定）。TS 的 ESM 绑定
 *     不可写，改为在依赖边界 `vi.mock` —— 覆盖面反而更大（连真实调用点一起覆盖）。
 *  2. Python 的 `_inline_jobs` 把后台任务塞进**请求的同一个会话**执行；
 *     TS 的 runGenerateJob 刻意用独立会话（请求会话随响应关闭，不可复用），
 *     所以这里改成「先发请求 → 再手动跑一次入队任务」，断言最终库状态。
 *  3. `test_generate_requires_apply_id` 在 Python 里断言 400，但当前
 *     app/routers/data.py 的逻辑是「无 apply_id → 管理员直接分配，自动建一条申请」
 *     （payload.apply_id 为 None 时走 else 分支）—— 那份用例已落后于实现。
 *     TS 侧按实现断言「自动建单」这条真实行为。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { getSettings } from '../../src/config/env.js';
import { dataApplies, type ApplyStatus, type DataApply } from '../../src/db/schema.js';
import { withSession } from '../../src/db/session.js';
import { resetJobs } from '../../src/services/jobs.js';
import { buildTestApp, request, seedUser } from './helpers.js';
import { resetDatabase } from './setup.js';

/* ---------------- 外部系统 / 后台执行器替身 ---------------- */

interface UploadCall {
  readonly localPath: string;
  readonly remoteDir: string | undefined;
  readonly remoteName: string | undefined;
  readonly lockOwner: string | undefined;
}

const { jobState } = vi.hoisted(() => ({
  jobState: {
    /** 入队但未执行的任务：测试可按需同步跑完 */
    queued: [] as { applyId: number; task: () => Promise<void> }[],
    /** submitGenerate 的返回值；置 false 可模拟「任务正在跑」 */
    accept: true,
    inflight: false,
  },
}));

const { uploadState } = vi.hoisted(() => ({
  uploadState: { calls: [] as UploadCall[] },
}));

const { genState } = vi.hoisted(() => ({
  genState: { boom: false, rows: 5, columns: 2 },
}));

vi.mock('../../src/services/jobs.js', () => ({
  submitGenerate: (applyId: number, task: () => Promise<void>): boolean => {
    if (!jobState.accept) return false;
    jobState.queued.push({ applyId, task });
    return true;
  },
  isInflight: (): boolean => jobState.inflight,
  resetJobs: (): void => { jobState.queued = []; },
}));

vi.mock('../../src/integrations/transfer.js', () => ({
  TransferError: class TransferError extends Error {},
  decodeRemote: (data: Buffer): string => data.toString('utf8'),
  connectSsh: async (): Promise<never> => { throw new Error('tests must not open SSH'); },
  execCommand: async (): Promise<{ stdout: string; stderr: string; code: number }> =>
    ({ stdout: '', stderr: '', code: 0 }),
  withSftp: async (): Promise<never> => { throw new Error('tests must not open SFTP'); },
  ensureRemoteDir: async (): Promise<void> => undefined,
  runIcaclsLock: async (): Promise<void> => undefined,
  uploadFileToWindows: async (
    localPath: string,
    options: { remoteDir?: string; remoteName?: string; lockOwner?: string } = {},
  ): Promise<string> => {
    uploadState.calls.push({
      localPath,
      remoteDir: options.remoteDir,
      remoteName: options.remoteName,
      lockOwner: options.lockOwner,
    });
    return `${(options.remoteDir ?? '').replace(/\//g, '\\')}\\${options.remoteName ?? ''}`;
  },
  listRemoteFiles: async (): Promise<readonly { filename: string; size: number }[]> => [],
  downloadFileFromWindows: async (): Promise<void> => undefined,
}));

vi.mock('../../src/services/dataset.js', () => ({
  timestampFilename: (prefix: string): string => `${prefix}_20260101_000000.xlsx`,
  analyzeTableColumns: async (): Promise<readonly unknown[]> => [],
  generateFilteredExcelFromTable: async (
    _db: unknown,
    _table: string,
    outPath: string,
  ): Promise<readonly [number, number]> => {
    if (genState.boom) throw new Error('磁盘满');
    mkdirSync(join(outPath, '..'), { recursive: true });
    writeFileSync(outPath, 'fake-xlsx');
    return [genState.rows, genState.columns] as const;
  },
}));

/* ---------------- 夹具 ---------------- */

let app: FastifyInstance;

const createApply = async (
  userId: number,
  status: ApplyStatus = 'pending',
): Promise<DataApply> =>
  withSession(async (db) => {
    const [row] = await db.db.insert(dataApplies).values({
      userId,
      purpose: '回归测试',
      status,
    }).returning();
    return row!;
  });

const findApply = async (id: number): Promise<DataApply | undefined> =>
  withSession(async (db) => {
    const [row] = await db.db.select().from(dataApplies).where(eq(dataApplies.id, id)).limit(1);
    return row;
  });

/** C1 的等价物：把队列里的后台任务同步跑完（Python 的 _inline_jobs） */
const drainJobs = async (): Promise<void> => {
  while (jobState.queued.length > 0) {
    const job = jobState.queued.shift()!;
    await job.task();
  }
};

const generatePayload = (targetUserId: number, applyId?: number) => ({
  target_user_id: targetUserId,
  filters: { sex33: 1 },
  filename: 'subset.xlsx',
  ...(applyId === undefined ? {} : { apply_id: applyId }),
});

beforeEach(async () => {
  await resetDatabase();
  app ??= await buildTestApp();

  jobState.queued = [];
  jobState.accept = true;
  jobState.inflight = false;
  uploadState.calls = [];
  genState.boom = false;
  resetJobs();
});

afterAll(async () => {
  await app?.close();
});

/* ============================================================
 * /data/fetch 已停用（A1）
 * ============================================================ */

describe('POST /data/fetch（已停用）', () => {
  it('任意登录用户直接拉取全量宽表必须 403', async () => {
    const user = await seedUser({ username: 'user1' });

    const response = await request(app, { method: 'POST', url: '/data/fetch', user });
    expect(response.statusCode).toBe(403);
    expect(response.json<{ detail: string }>().detail).toContain('申请');
  });

  it('管理员也不得绕过申请流程直拉全量', async () => {
    const admin = await seedUser({ username: 'admin', role: 'admin' });

    const response = await request(app, { method: 'POST', url: '/data/fetch', user: admin });
    expect(response.statusCode).toBe(403);
  });
});

/* ============================================================
 * POST /data/generate 必须绑定有效申请（A1/B6）
 * ============================================================ */

describe('POST /data/generate 申请校验', () => {
  it('未带 apply_id：管理员直接分配，自动建一条申请作为痕迹', async () => {
    // ⚠️ 与 tests/test_data_fetch.py::test_generate_requires_apply_id 的断言不同：
    // 那份用例期望 400，但 app/routers/data.py 在 payload.apply_id 为假值时走
    // 「管理员直接分配」分支自动建单（见 FilteredDataGenerateRequest.apply_id 可选）。
    // TS 侧按真实实现断言自动建单，行为与 Python 运行时一致。
    const admin = await seedUser({ username: 'admin', role: 'admin' });
    const target = await seedUser({ username: 'gen_user' });

    const response = await request(app, {
      method: 'POST',
      url: '/data/generate',
      user: admin,
      payload: generatePayload(target.id),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ status: string }>().status).toBe('generating');

    const created = await withSession(async (db) => {
      const rows = await db.db.select().from(dataApplies).where(eq(dataApplies.userId, target.id));
      return rows;
    });
    expect(created).toHaveLength(1);
    expect(created[0]!.purpose).toBe('管理员直接分配');
  });

  it('申请必须属于目标用户，不能拿他人申请冒名生成', async () => {
    const admin = await seedUser({ username: 'admin', role: 'admin' });
    const target = await seedUser({ username: 'gen_target' });
    const other = await seedUser({ username: 'gen_other' });
    const apply = await createApply(other.id);

    const response = await request(app, {
      method: 'POST',
      url: '/data/generate',
      user: admin,
      payload: generatePayload(target.id, apply.id),
    });
    expect(response.statusCode).toBe(400);
  });

  it('已完成的申请不可重复生成', async () => {
    const admin = await seedUser({ username: 'admin', role: 'admin' });
    const target = await seedUser({ username: 'gen_done' });
    const apply = await createApply(target.id, 'completed');

    const response = await request(app, {
      method: 'POST',
      url: '/data/generate',
      user: admin,
      payload: generatePayload(target.id, apply.id),
    });
    expect(response.statusCode).toBe(400);
  });

  it('被拒绝的申请不可生成', async () => {
    const admin = await seedUser({ username: 'admin', role: 'admin' });
    const target = await seedUser({ username: 'gen_rej' });
    const apply = await createApply(target.id, 'rejected');

    const response = await request(app, {
      method: 'POST',
      url: '/data/generate',
      user: admin,
      payload: generatePayload(target.id, apply.id),
    });
    expect(response.statusCode).toBe(400);
  });

  it('有效申请：生成成功 → 申请置 completed → 投递到私有目录并以本人锁定', async () => {
    const admin = await seedUser({ username: 'admin', role: 'admin' });
    const target = await seedUser({ username: 'gen_ok' });
    const apply = await createApply(target.id);

    const response = await request(app, {
      method: 'POST',
      url: '/data/generate',
      user: admin,
      payload: generatePayload(target.id, apply.id),
    });
    expect(response.statusCode).toBe(200);

    await drainJobs();

    const after = await findApply(apply.id);
    expect(after?.status).toBe('completed');
    expect(after?.processedBy).not.toBeNull();
    expect(after?.finishedAt).not.toBeNull();

    const last = uploadState.calls.at(-1)!;
    expect(last.remoteName).toBe('subset.xlsx');
    expect(last.remoteDir).toBe(`${getSettings().windowsWorkspaceDir}/gen_ok`);
    expect(last.lockOwner).toBe('gen_ok');
  });
});

/* ============================================================
 * 生成异步化（C1）
 * ============================================================ */

describe('生成异步化（C1）', () => {
  it('接口认领后立即返回，申请进入 generating', async () => {
    const admin = await seedUser({ username: 'admin', role: 'admin' });
    const target = await seedUser({ username: 'gen_async' });
    const apply = await createApply(target.id);

    const response = await request(app, {
      method: 'POST',
      url: '/data/generate',
      user: admin,
      payload: generatePayload(target.id, apply.id),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ status: string; apply_id: number }>()).toMatchObject({
      status: 'generating',
      apply_id: apply.id,
    });

    // 任务还在队列里没跑 —— 证明「提交即返回」
    expect(jobState.queued).toHaveLength(1);

    const after = await findApply(apply.id);
    expect(after?.status).toBe('generating');
    expect(after?.processedBy).not.toBeNull();
  });

  it('后台生成失败 → 置 failed 并记录原因；修复后可从 failed 重试', async () => {
    const admin = await seedUser({ username: 'admin', role: 'admin' });
    const target = await seedUser({ username: 'gen_fail' });
    const apply = await createApply(target.id);

    genState.boom = true;
    const first = await request(app, {
      method: 'POST',
      url: '/data/generate',
      user: admin,
      payload: generatePayload(target.id, apply.id),
    });
    expect(first.statusCode).toBe(200);

    await drainJobs();

    const failed = await findApply(apply.id);
    expect(failed?.status).toBe('failed');
    expect(failed?.rejectReason).toContain('磁盘满');
    expect(uploadState.calls).toEqual([]); // 失败发生在生成阶段，未触达 SFTP

    // 故障修复后从 failed 重新生成
    genState.boom = false;
    const retry = await request(app, {
      method: 'POST',
      url: '/data/generate',
      user: admin,
      payload: generatePayload(target.id, apply.id),
    });
    expect(retry.statusCode).toBe(200);

    await drainJobs();

    const recovered = await findApply(apply.id);
    expect(recovered?.status).toBe('completed');
    expect(uploadState.calls.at(-1)!.remoteName).toBe('subset.xlsx');
  });

  it('同一申请已有任务在跑时，重复提交返回 409', async () => {
    const admin = await seedUser({ username: 'admin', role: 'admin' });
    const target = await seedUser({ username: 'gen_dup' });
    const apply = await createApply(target.id);

    jobState.accept = false; // 模拟执行器拒绝（任务在跑）

    const response = await request(app, {
      method: 'POST',
      url: '/data/generate',
      user: admin,
      payload: generatePayload(target.id, apply.id),
    });
    expect(response.statusCode).toBe(409);
  });

  it('stale「生成中」（进程重启残留）允许重新认领', async () => {
    const admin = await seedUser({ username: 'admin', role: 'admin' });
    const target = await seedUser({ username: 'gen_stale' });
    const apply = await createApply(target.id, 'generating');
    jobState.inflight = false; // 内存中并没有任务在跑

    const response = await request(app, {
      method: 'POST',
      url: '/data/generate',
      user: admin,
      payload: generatePayload(target.id, apply.id),
    });
    expect(response.statusCode).toBe(200);
  });
});

/* ============================================================
 * 平台配置落库消费（C4）
 * ============================================================ */

describe('投递根目录优先取平台配置库（C4）', () => {
  it('管理端保存 workspace_dir 后，生成投递立即生效', async () => {
    const admin = await seedUser({ username: 'admin', role: 'admin' });
    const target = await seedUser({ username: 'gen_cfg' });
    const apply = await createApply(target.id);

    const saved = await request(app, {
      method: 'PUT',
      url: '/admin/platform-config',
      user: admin,
      payload: {
        host: '', port: 22, username: '', workspace_dir: 'D:/cfg_workspace', output_path: '',
      },
    });
    expect(saved.statusCode).toBe(200);

    const generated = await request(app, {
      method: 'POST',
      url: '/data/generate',
      user: admin,
      payload: generatePayload(target.id, apply.id),
    });
    expect(generated.statusCode).toBe(200);

    await drainJobs();
    expect(uploadState.calls.at(-1)!.remoteDir).toBe('D:/cfg_workspace/gen_cfg');
  });
});
