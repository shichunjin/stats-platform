/**
 * upload_file_to_windows 的私有 ACL 锁定 —— tests/test_transfer_lock.py
 *
 * 不触网：通过 `vi.mock('ssh2')` 把 SSH 客户端整个替换成内存替身。
 * Python 侧用 monkeypatch 换掉模块内的 `_connect_sftp`（私有函数）；
 * TS 侧没有「私有函数」概念，且 `connectSsh` 是模块内的 const 无法被 patch，
 * 因此改为在**依赖边界**（ssh2 包）上打桩 —— 这也顺带覆盖了真实的
 * connectSsh / execCommand 代码路径，比 Python 侧的替身覆盖面更大。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

/* ---------------- ssh2 替身 ---------------- */

interface FakeState {
  exitCode: number;
  commands: string[];
  ended: boolean;
}

const state: FakeState = { exitCode: 0, commands: [], ended: false };

class FakeSftp {
  readonly mkdirCalls: string[] = [];

  stat(_path: string, callback: (error: Error | null) => void): void {
    callback(new Error('ENOENT'));
  }

  mkdir(path: string, callback: (error: Error | null) => void): void {
    this.mkdirCalls.push(path);
    callback(null);
  }

  fastPut(_local: string, _remote: string, callback: (error: Error | null) => void): void {
    callback(null);
  }

  end(): void {}
}

class FakeChannel extends EventEmitter {
  readonly stderr = new EventEmitter();

  constructor(private readonly code: number, stdout: string) {
    super();
    // 与真实 channel 一致：数据在 close 之前异步到达
    queueMicrotask(() => {
      this.emit('data', Buffer.from(stdout, 'utf8'));
      this.emit('close', this.code);
    });
  }

  write(): void {}

  end(): void {}

  close(): void {}
}

class FakeClient extends EventEmitter {
  // 字段名不能叫 sftp：会和下面的 sftp() 方法重名，esbuild 会直接丢掉方法
  private readonly sftpHandle = new FakeSftp();

  connect(): void {
    queueMicrotask(() => this.emit('ready'));
  }

  sftp(callback: (error: Error | undefined, handle: FakeSftp) => void): void {
    callback(undefined, this.sftpHandle);
  }

  exec(command: string, callback: (error: Error | undefined, channel: FakeChannel) => void): void {
    state.commands.push(command);
    callback(undefined, new FakeChannel(state.exitCode, 'processed file: a.xlsx'));
  }

  end(): void {
    state.ended = true;
  }
}

vi.mock('ssh2', () => ({
  Client: FakeClient,
}));

/* ---------------- 被测模块必须在 mock 之后动态导入 ---------------- */

const { uploadFileToWindows, TransferError } = await import('../../src/integrations/transfer.js');
const { overrideSettings } = await import('../../src/config/env.js');

let localFile: string;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'stats_transfer_'));
  localFile = join(tmpDir, 'testData_20260101_000000.xlsx');
  writeFileSync(localFile, 'xlsx');

  // connectSsh 会先做私钥存在性检查（fail-fast）；指向一个真实存在的文件即可，
  // 后续 connect 走的是 ssh2 替身，不会真的读它
  overrideSettings({ sftpKeyPath: localFile });
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  state.exitCode = 0;
  state.commands = [];
  state.ended = false;
});

describe('upload_file_to_windows', () => {
  it('未传 lock_owner 时不执行 icacls，且连接一定被关闭', async () => {
    await uploadFileToWindows(localFile, { remoteDir: 'C:/StatsData', remoteName: 'a.xlsx' });

    expect(state.commands).toEqual([]);
    expect(state.ended).toBe(true);
  });

  it('传 lock_owner 时对目录与文件各执行一次 icacls 收敛', async () => {
    const winPath = await uploadFileToWindows(localFile, {
      remoteDir: 'C:/workspace/user2',
      remoteName: 'a.xlsx',
      lockOwner: 'user2',
    });

    expect(winPath).toBe('C:\\workspace\\user2\\a.xlsx');
    expect(state.commands).toHaveLength(2);

    const [dirCmd, fileCmd] = state.commands as [string, string];

    // 目录：断开继承 + 本人完全控制（带继承标志）+ SYSTEM/Administrators
    expect(dirCmd).toContain('icacls "C:\\workspace\\user2"');
    expect(dirCmd).toContain('/inheritance:r');
    expect(dirCmd).toContain('"user2:(OI)(CI)F"');
    expect(dirCmd).toContain('"*S-1-5-18:(OI)(CI)F"');
    expect(dirCmd).toContain('"*S-1-5-32-544:(OI)(CI)F"');

    // 文件本身不继承（无 (OI)(CI)），防止投递瞬间继承来的他人读权限残留
    expect(fileCmd).toContain('icacls "C:\\workspace\\user2\\a.xlsx"');
    expect(fileCmd).toContain('"user2:F"');
    expect(fileCmd.split('"user2')[1] ?? '').not.toContain('(OI)(CI)');
  });

  it('非法 owner 直接拒绝，不建立任何连接', async () => {
    await expect(uploadFileToWindows(localFile, { lockOwner: '../evil' }))
      .rejects.toThrow(TransferError);

    expect(state.commands).toEqual([]);
  });

  it('icacls 失败时抛错，且连接仍然被关闭', async () => {
    state.exitCode = 5;

    await expect(uploadFileToWindows(localFile, {
      remoteDir: 'C:/workspace/user2',
      lockOwner: 'user2',
    })).rejects.toThrow(/权限锁定失败/);

    expect(state.ended).toBe(true);
  });

  it('本地文件不存在时提前失败', async () => {
    await expect(uploadFileToWindows(join(tmpDir, '__missing__.xlsx')))
      .rejects.toThrow(/待上传文件不存在/);
  });
});
