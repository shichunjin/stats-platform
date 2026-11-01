/**
 * 「申请导出」SFTP 回拉链路测试 —— tests/test_results_pull.py
 *
 * 覆盖链路：Windows 云主机 `C:\pending\{用户名}` →（SFTP）→ 服务器暂存目录。
 *
 * 历史缺陷：request-export 只扫描服务器本地 `fileserver_root/pending/{id}/`，
 * 用户保存在 Windows 待导出目录（RESULTS_DIR）的结果文件永远不会被拉回，
 * 前端恒提示「没有新的结果文件可申请」。
 *
 * 与 Python 的几处差异（都写在注释里，避免后人误以为是漏测）：
 *  1. Python 用 `monkeypatch.setattr(transfer, "_connect_sftp", ...)` 换掉模块内的
 *     **私有函数**。TS 没有私有函数概念，且 `connectSsh` 是模块内 const 绑定不可写，
 *     因此改为在**依赖边界** `vi.mock('ssh2')` 打桩 —— 顺带覆盖了真实的
 *     connectSsh / withSftp / listRemoteFiles / downloadFileFromWindows 代码路径，
 *     比 Python 侧的替身覆盖面更大。
 *  2. 502 用例：Python 直接 monkeypatch `results_routes.list_remote_files` 抛 OSError。
 *     TS 改为让替身的 SFTP 通道建立失败（等价的「远端不可达」），
 *     错误照样冒泡到路由的 try/catch，同样产出 502。
 *  3. `test_api_register_after_pull` 在 Python 里 **不带请求体**调
 *     `POST /results/request-export`；但 `RequestExportRequest.file_names` 是必填
 *     （min_length=1），TS 的 `requestExportSchema` 同样是必填 —— 那份用例已落后于
 *     实现（Python 侧跑也会 422）。TS 按真实契约带上 `file_names`。
 */
import { EventEmitter } from 'node:events';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
// 纯类型导入会被擦除，不影响「src 模块必须在 vi.mock 之后动态导入」的顺序约束
import type { User } from '../../src/db/schema.js';

/* ---------------- ssh2 替身 ---------------- */

interface RemoteCall {
  readonly remotePath: string;
  readonly localPath: string;
}

/**
 * 用 vi.hoisted 初始化：vi.mock 的工厂会在模块体求值**之前**被提升，
 * 直接引用模块作用域的 const 会踩 TDZ。
 */
const { remote } = vi.hoisted(() => ({
  remote: {
    /** 远端目录内容：文件名 -> 内容；null 表示子目录 */
    files: {} as Record<string, Buffer | null>,
    /** 读取即抛错的远端目录（模拟目录不存在） */
    missingDirs: [] as string[],
    /** 每次 readdir 的目录，用于断言远端路径按用户名拼出 */
    listed: [] as string[],
    /** 每次 fastGet 的 (远端路径, 本地路径) */
    gets: [] as RemoteCall[],
    /** 置 true 模拟「SSH 能连上但 SFTP 通道建立失败」= 远端不可达 */
    failSftp: false,
    /** SSH 连接被关闭的次数：验证资源一定释放 */
    ended: 0,
  },
}));

interface FakeAttrs {
  readonly size: number;
  readonly isDirectory: () => boolean;
}

class FakeSftp {
  readdir(
    remoteDir: string,
    callback: (error: Error | null, list: { filename: string; attrs: FakeAttrs }[] | null) => void,
  ): void {
    remote.listed.push(remoteDir);

    if (remote.missingDirs.includes(remoteDir)) {
      callback(new Error(`no such directory: ${remoteDir}`), null);
      return;
    }

    callback(null, Object.entries(remote.files).map(([filename, blob]) => ({
      filename,
      attrs: { size: blob === null ? 0 : blob.length, isDirectory: () => blob === null },
    })));
  }

  fastGet(remotePath: string, localPath: string, callback: (error: Error | null) => void): void {
    remote.gets.push({ remotePath, localPath });

    const filename = remotePath.slice(remotePath.lastIndexOf('/') + 1);
    const blob = remote.files[filename];
    if (blob === null || blob === undefined) {
      callback(new Error(`no such file: ${remotePath}`));
      return;
    }

    writeFileSync(localPath, blob);
    callback(null);
  }

  end(): void {}
}

class FakeClient extends EventEmitter {
  // 字段名不能叫 sftp：会和下面的 sftp() 方法重名，esbuild 会直接丢掉方法
  private readonly sftpHandle = new FakeSftp();

  connect(): void {
    queueMicrotask(() => this.emit('ready'));
  }

  sftp(callback: (error: Error | undefined, handle: FakeSftp) => void): void {
    if (remote.failSftp) {
      callback(new Error('connection refused'), undefined as unknown as FakeSftp);
      return;
    }
    callback(undefined, this.sftpHandle);
  }

  exec(): void {
    throw new Error('tests must not exec remote commands');
  }

  end(): void {
    remote.ended += 1;
  }
}

vi.mock('ssh2', () => ({ Client: FakeClient }));

/* ---------------- 被测模块必须在 mock 之后动态导入 ---------------- */

const { pullUserPending } = await import('../../src/routers/results.js');
const { downloadFileFromWindows, listRemoteFiles } = await import('../../src/integrations/transfer.js');
const { getSettings, overrideSettings } = await import('../../src/config/env.js');
const { buildTestApp, request, seedUser } = await import('./helpers.js');
const { resetDatabase } = await import('./setup.js');

interface RequestExportBody {
  readonly registered: number;
  readonly files: readonly { readonly file_name: string; readonly status: string }[];
  readonly auto_approved: number;
  readonly rejected: number;
  readonly skipped: readonly string[];
  readonly not_found: readonly string[];
}

interface MyResultsBody {
  readonly pending: readonly { readonly file_name: string; readonly status: string }[];
  readonly published: readonly { readonly result_name: string }[];
}

/* ---------------- 夹具 ---------------- */

let app: FastifyInstance;
let tmpDir: string;
let user: User;

/** 安装远端目录内容；每次调用都重置替身记录（对应 Python 的 remote_sftp 工厂） */
const installRemote = (
  files: Record<string, Buffer | null>,
  missingDirs: readonly string[] = [],
): void => {
  remote.files = { ...files };
  remote.missingDirs = [...missingDirs];
  remote.listed = [];
  remote.gets = [];
  remote.failSftp = false;
  remote.ended = 0;
};

/** 清空并重建用户的本地 pending 目录（对应 conftest 的 pending_dir fixture） */
const resetPendingDir = (userId: number): string => {
  const dir = join(getSettings().fileserverRoot, 'pending', String(userId));
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
};

const remoteDirFor = (username: string): string =>
  `${getSettings().windowsPendingDir.replace(/\/$/, '')}/${username}`;

const names = (paths: readonly string[]): string[] => paths.map((p) => basename(p));

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'stats_pull_'));

  // connectSsh 会先做私钥存在性检查（fail-fast）；指向一个真实存在的文件即可，
  // 后续 ssh.connect 走的是 ssh2 替身，不会真的解析它
  const keyPath = join(tmpDir, 'fake_key');
  writeFileSync(keyPath, 'not-a-real-key\n');
  overrideSettings({ sftpKeyPath: keyPath });

  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetDatabase();
  installRemote({});
  user = await seedUser({ username: 'user1', displayName: '测试用户1' });
});

/* ---------------- 编排函数 pull_user_pending ---------------- */

describe('pull_user_pending', () => {
  it('按用户名拼远端目录，允许所有文件类型，跳过子目录', async () => {
    installRemote({
      'model.out': Buffer.from('regression output'),
      'result.xlsx': Buffer.from('excel binary blob'),
      'chart.png': Buffer.from('png bytes'),
      'report.pdf': Buffer.from('pdf bytes'),
      subdir: null,
    });
    const localDir = join(tmpDir, 'pending');

    const pulled = await pullUserPending(user, localDir);

    // 远端目录必须按用户名（与投递侧、login.ps1 的 RESULTS_DIR 约定一致）
    expect(remote.listed).toEqual([remoteDirFor('user1')]);
    // 所有文件类型都允许回拉（是否放行由后续相似度审核决定），子目录不拉
    expect(new Set(names(pulled))).toEqual(
      new Set(['model.out', 'result.xlsx', 'chart.png', 'report.pdf']),
    );
    expect(existsSync(join(localDir, 'subdir'))).toBe(false);
    expect(new Set(remote.gets.map((call) => basename(call.remotePath))))
      .toEqual(new Set(names(pulled)));
  });

  it('同名同大小跳过，大小变化则重新下载覆盖', async () => {
    const localDir = join(tmpDir, 'pending_inc');
    mkdirSync(localDir, { recursive: true });
    writeFileSync(join(localDir, 'model.out'), Buffer.from('abc'));

    installRemote({ 'model.out': Buffer.from('abc'), 'new.log': Buffer.from('ll') });
    const pulled = await pullUserPending(user, localDir);

    expect(names(pulled)).toEqual(['new.log']);
    expect(remote.gets).toHaveLength(1);
    expect(remote.gets[0]!.remotePath.endsWith('/new.log')).toBe(true);

    // 文件大小变化（远端更新）：必须重新下载覆盖
    installRemote({ 'model.out': Buffer.from('abc-changed') });
    const pulled2 = await pullUserPending(user, localDir);

    expect(names(pulled2)).toEqual(['model.out']);
    expect(readFileSync(join(localDir, 'model.out'))).toEqual(Buffer.from('abc-changed'));
  });

  it('远端目录不存在时返回空列表', async () => {
    installRemote({}, [remoteDirFor('user1')]);

    await expect(pullUserPending(user, join(tmpDir, 'missing_remote'))).resolves.toEqual([]);
  });

  it('过滤路径穿越文件名，不落到父目录', async () => {
    installRemote({ '../evil.out': Buffer.from('x'), 'ok.out': Buffer.from('y') });

    const pulled = await pullUserPending(user, join(tmpDir, 'traversal'));

    expect(names(pulled)).toEqual(['ok.out']);
    expect(existsSync(join(tmpDir, 'evil.out'))).toBe(false);
  });
});

/* ---------------- API：POST /results/request-export ---------------- */

describe('POST /results/request-export', () => {
  it('回拉 Windows 待导出文件后登记为待审核，重复申请不再登记', async () => {
    resetPendingDir(user.id);
    installRemote({ 'regression.out': Buffer.from('output line\n') });

    const first = await request(app, {
      method: 'POST',
      url: '/results/request-export',
      user,
      payload: { file_names: ['regression.out'] },
    });

    expect(first.statusCode).toBe(200);
    const body = first.json<RequestExportBody>();
    // 基线缺失 → 相似度无法判定 → 安全默认转人工审核（registered=1）
    expect(body.registered).toBe(1);
    expect(body.files[0]!.file_name).toBe('regression.out');

    // 再次申请：文件已登记且远端未变化 -> registered=0
    const again = await request(app, {
      method: 'POST',
      url: '/results/request-export',
      user,
      payload: { file_names: ['regression.out'] },
    });

    expect(again.statusCode).toBe(200);
    expect(again.json<RequestExportBody>().registered).toBe(0);
    expect(again.json<RequestExportBody>().skipped).toEqual(['regression.out']);

    const mine = await request(app, { method: 'GET', url: '/results/mine', user });
    expect(mine.statusCode).toBe(200);
    expect(mine.json<MyResultsBody>().pending.map((p) => p.file_name)).toEqual(['regression.out']);
  });

  it('Windows 不可达时返回 502 并提示来源', async () => {
    resetPendingDir(user.id);
    installRemote({ 'any.out': Buffer.from('x') });
    remote.failSftp = true;

    const response = await request(app, {
      method: 'POST',
      url: '/results/request-export',
      user,
      payload: { file_names: ['any.out'] },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json<{ detail: string }>().detail).toContain('Windows');
  });
});

/* ---------------- transfer 原语 ---------------- */

describe('transfer 原语', () => {
  it('list_remote_files：目录不存在返回空数组', async () => {
    installRemote({}, ['C:/pending/user1']);

    await expect(listRemoteFiles('C:/pending/user1')).resolves.toEqual([]);
  });

  it('download_file_from_windows：自动创建本地父目录', async () => {
    installRemote({ 'a.out': Buffer.from('data') });
    const target = join(tmpDir, 'nested', 'deep', 'a.out');

    await downloadFileFromWindows('C:/pending/user1', 'a.out', target);

    expect(readFileSync(target)).toEqual(Buffer.from('data'));
  });
});
