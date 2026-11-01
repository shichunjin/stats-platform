/**
 * Windows 云主机账号同步测试 —— tests/test_windows_account.py
 *
 * SSH 层全部用替身，不触网。与 Python 的差异：
 *  1. Python 的 FakeSSH 替身实现 paramiko 的 `exec_command` 三元组（stdin/stdout/stderr）；
 *     TS 侧 ssh2 是「exec + channel.write + close 事件」，因此替身打在
 *     `connectSsh` / `execCommand` 这两个函数上（windows-account 只依赖它们）。
 *     这样 `runRemotePs` 里真实构造的 stdin 包装器仍然被完整覆盖。
 *  2. `windowsSyncEnabled()`（C5）是 TS 新增的守卫：Python 的同步开关只看
 *     windows_account_sync，这里多了 sftp_host 非空判断，因此「同步关闭」用例
 *     用 overrideSettings 一次置两个字段。
 *  3. Python 的 `wa._decode_remote` 在 TS 里是 `transfer.ts` 的 `decodeRemote`（已导出）。
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { getSettings, overrideSettings } from '../../src/config/env.js';
import { users } from '../../src/db/schema.js';
import { withSession } from '../../src/db/session.js';
import {
  WindowsAccountError, buildAccountScript, provisionUserWorkspace, syncWindowsUser,
  validateWindowsUsername, windowsSyncEnabled,
} from '../../src/integrations/windows-account.js';
import { decodeRemote } from '../../src/integrations/transfer.js';
// 纯类型命名空间导入：供下面 vi.mock 工厂里的 importOriginal<T>() 取原模块类型
import type * as TransferModule from '../../src/integrations/transfer.js';
import { buildTestApp, request } from './helpers.js';
import { resetDatabase } from './setup.js';

/* ---------------- SSH 替身 ---------------- */

const { sshState } = vi.hoisted(() => ({
  sshState: {
    exitCode: 0,
    out: 'STATS_WINDOWS_USER_CREATED',
    err: '',
    connectError: null as Error | null,
    calls: [] as { command: string; stdin: string | undefined }[],
    closed: false,
  },
}));

vi.mock('../../src/integrations/transfer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof TransferModule>();
  return {
    ...actual,
    connectSsh: async (): Promise<{ end: () => void }> => {
      if (sshState.connectError) throw sshState.connectError;
      return { end: (): void => { sshState.closed = true; } };
    },
    execCommand: async (
      _ssh: unknown,
      command: string,
      options: { readonly stdin?: string; readonly timeoutMs?: number } = {},
    ): Promise<{ code: number; stdout: Buffer; stderr: Buffer }> => {
      sshState.calls.push({ command, stdin: options.stdin });
      return {
        code: sshState.exitCode,
        stdout: Buffer.from(sshState.out, 'utf8'),
        stderr: Buffer.from(sshState.err, 'utf8'),
      };
    },
  };
});

/** 从 stdin 包装器中提取并解码 UTF-16LE Base64 载荷（实际执行的 PS 脚本） */
const decodePayload = (stdin: string | undefined): string => {
  expect(stdin).toBeDefined();
  const match = /FromBase64String\('([^']+)'\)/.exec(stdin!);
  expect(match, 'stdin 应包含 Base64 载荷').not.toBeNull();
  // Node 的 Buffer 直接支持 utf16le（Python 侧是 base64.b64decode(...).decode('utf-16-le')）
  return Buffer.from(match![1]!, 'base64').toString('utf16le');
};

/* ---------------- 夹具 ---------------- */

let app: FastifyInstance;
const ORIGINAL = { ...getSettings() };

beforeEach(async () => {
  await resetDatabase();
  app ??= await buildTestApp();

  sshState.exitCode = 0;
  sshState.out = 'STATS_WINDOWS_USER_CREATED';
  sshState.err = '';
  sshState.connectError = null;
  sshState.calls = [];
  sshState.closed = false;

  overrideSettings({
    windowsAccountSync: false,
    sftpHost: ORIGINAL.sftpHost,
    guacDbUrl: '',
    windowsPasswordNeverExpires: false,
  });
});

afterAll(async () => {
  overrideSettings(ORIGINAL);
  await app?.close();
});

/* ============================================================
 * 用户名规则
 * ============================================================ */

describe('Windows 用户名规则', () => {
  it.each(['ab', 'a'.repeat(21), '张三', 'bad name', 'a@b', 'a/b', 'a"b', 'a;b', 'a*b', 'a?b', '', 'a|b'])(
    '非法用户名 %j 拒绝',
    (bad) => {
      expect(() => validateWindowsUsername(bad)).toThrow(WindowsAccountError);
    },
  );

  it.each(['abc', 'user.name-1_x', 'A'.repeat(20), 'u01'])(
    '合法用户名 %j 通过',
    (good) => {
      expect(() => validateWindowsUsername(good)).not.toThrow();
    },
  );
});

/* ============================================================
 * sync_windows_user
 * ============================================================ */

describe('sync_windows_user', () => {
  it('同步关闭时不建立 SSH 连接', async () => {
    overrideSettings({ windowsAccountSync: false });

    expect(await syncWindowsUser('alice', 'Passw0rd!')).toBe(false);
    expect(sshState.calls).toEqual([]);
  });

  it('建号脚本内容符合安全约束', async () => {
    overrideSettings({ windowsAccountSync: true });

    // 含单引号的密码：验证 PowerShell 单引号转义（' -> ''）
    expect(await syncWindowsUser('alice', "a'b$c")).toBe(true);

    expect(sshState.calls).toHaveLength(1);
    const [call] = sshState.calls as [{ command: string; stdin: string }];
    expect(call.command).toContain('powershell');
    expect(call.command).toContain('-Command -');
    expect(sshState.closed).toBe(true);

    // stdin 包装器本身必须是纯 ASCII（绕开 GBK 代码页问题）
    // eslint-disable-next-line no-control-regex -- 断言目标就是「0x00-0x7F 之外一个字节都没有」
    expect(/^[\x00-\x7F]*$/.test(call.stdin)).toBe(true);

    const inner = decodePayload(call.stdin);
    expect(inner).toContain("$username = 'alice'");
    expect(inner).toContain("$password = 'a''b$c'");
    expect(inner).toContain('New-LocalUser');
    expect(inner).toContain('Set-LocalUser');
    expect(inner).toContain('S-1-5-32-545'); // Users
    expect(inner).toContain('S-1-5-32-555'); // Remote Desktop Users
    // 语言无关的幂等加组：成员预检 + MemberExists 错误码（不能匹配英文报错文本）
    expect(inner).toContain('Ensure-GroupMember');
    expect(inner).toContain('MemberExists');
    expect(inner).not.toContain('already a member');

    // 建号同一脚本里必须开通私有工作区并锁定 ACL（数据隔离强约束）
    expect(inner).toContain("$workspaceRoot = 'C:\\workspace'");
    expect(inner).toContain("$pendingRoot   = 'C:\\pending'");
    expect(inner).toContain('New-SmbShare');
    expect(inner).toContain('FolderEnumerationMode AccessBased');
    expect(inner).toContain('icacls');
    expect(inner).toContain('/inheritance:r');
    // SYSTEM / Administrators 用 SID，不能依赖中文版本地化名
    expect(inner).toContain('*S-1-5-18');
    expect(inner).toContain('*S-1-5-32-544');
    // 私有目录按用户名建，不能再用数字 ID
    expect(inner).toContain('Join-Path $workspaceRoot $username');
    expect(inner).toContain('STATS_WINDOWS_WORKSPACE_READY');
    // 建号路径不递归重置（目录是新建的，空目录）
    expect(inner).toContain('$deepReset     = $false');
  });

  it('远端非零退出码抛错（GBK 中文错误可解码）', async () => {
    overrideSettings({ windowsAccountSync: true });
    sshState.exitCode = 1;
    sshState.err = 'Set-LocalUser : 密码不满足长度、复杂性或历史要求';

    await expect(syncWindowsUser('alice', '123')).rejects.toThrow(/Windows 账号同步失败/);
    expect(sshState.closed).toBe(true);
  });

  it('SSH 连接失败抛「无法连接 Windows 云主机」', async () => {
    overrideSettings({ windowsAccountSync: true });
    sshState.connectError = new Error('connection refused');

    await expect(syncWindowsUser('alice', 'Passw0rd!')).rejects.toThrow(/无法连接 Windows 云主机/);
  });

  it('密码含控制字符直接拒绝', async () => {
    overrideSettings({ windowsAccountSync: true });

    await expect(syncWindowsUser('alice', 'bad\npassword')).rejects.toThrow(/控制字符/);
  });
});

/* ============================================================
 * provision_user_workspace（老账号私有工作区补偿）
 * ============================================================ */

describe('provision_user_workspace', () => {
  it('同步关闭时不建立 SSH 连接', async () => {
    overrideSettings({ windowsAccountSync: false });

    expect(await provisionUserWorkspace('alice')).toBe(false);
    expect(sshState.calls).toEqual([]);
  });

  it('补偿脚本不需要密码，且不触碰账号本身', async () => {
    overrideSettings({ windowsAccountSync: true });
    sshState.out = 'STATS_WINDOWS_WORKSPACE_READY';

    expect(await provisionUserWorkspace('alice')).toBe(true);
    expect(sshState.calls).toHaveLength(1);

    const inner = decodePayload(sshState.calls[0]!.stdin);
    expect(inner).toContain("$username = 'alice'");
    expect(inner).not.toContain('New-LocalUser');
    expect(inner).not.toContain('Set-LocalUser');
    expect(inner).not.toContain('ConvertTo-SecureString');
    expect(inner).toContain('icacls');
    // 授权串按 $username 拼接，避免任何形式的硬编码他人账号
    expect(inner).toContain("$userGrant = $username + ':(OI)(CI)F'");
    expect(inner).toContain('$deepReset     = $false');
    // 递归重置逻辑必须由开关守护，浅模式下不触发
    expect(inner).toContain('if ($deepReset -and');
    expect(inner).toContain('STATS_WINDOWS_WORKSPACE_READY');
  });

  it('deep_reset 打开递归重置', async () => {
    overrideSettings({ windowsAccountSync: true });
    sshState.out = 'STATS_WINDOWS_WORKSPACE_READY';

    await provisionUserWorkspace('alice', true);
    const inner = decodePayload(sshState.calls[0]!.stdin);
    expect(inner).toContain('$deepReset     = $true');
    expect(inner).toContain('/T /C');
  });

  it('非法用户名不得触达 Windows', async () => {
    overrideSettings({ windowsAccountSync: true });

    await expect(provisionUserWorkspace('../evil')).rejects.toThrow(WindowsAccountError);
    expect(sshState.calls).toEqual([]);
  });

  it('远端失败抛「保障工作区」', async () => {
    overrideSettings({ windowsAccountSync: true });
    sshState.exitCode = 1;
    sshState.err = 'icacls: 拒绝访问';

    await expect(provisionUserWorkspace('alice')).rejects.toThrow(/保障工作区/);
    expect(sshState.closed).toBe(true);
  });
});

/* ============================================================
 * 远程输出解码
 * ============================================================ */

describe('decodeRemote', () => {
  it('中文版 Windows 的 GBK 输出能正确解码', async () => {
    const text = '已经是 Remote Desktop Users 组的成员';
    const iconv = (await import('iconv-lite')).default;

    expect(decodeRemote(iconv.encode(text, 'gbk'))).toBe(text);
    expect(decodeRemote(Buffer.from(text, 'utf8'))).toBe(text);
  });
});

/* ============================================================
 * 集成：注册链路
 * ============================================================ */

describe('注册链路', () => {
  const enableWindows = (): void => {
    overrideSettings({ windowsAccountSync: true, sftpHost: '10.99.0.1', guacDbUrl: '' });
  };

  it('注册触发 Windows 同步，并落库平台账号', async () => {
    enableWindows();

    const response = await request(app, {
      method: 'POST',
      url: '/auth/register',
      payload: { username: 'winuser', password: 'Winpass1' },
    });
    expect(response.statusCode).toBe(200);

    expect(sshState.calls).toHaveLength(1);
    const inner = decodePayload(sshState.calls[0]!.stdin);
    expect(inner).toContain("$username = 'winuser'");
    expect(inner).toContain("$password = 'Winpass1'");

    const count = await withSession(async (db) => {
      const rows = await db.db.select({ id: users.id }).from(users).where(eq(users.username, 'winuser'));
      return rows.length;
    });
    expect(count).toBe(1);
  });

  it('远端失败 → 502，且平台账号不得创建', async () => {
    enableWindows();
    sshState.exitCode = 1;
    sshState.err = '密码不满足复杂性要求';

    const response = await request(app, {
      method: 'POST',
      url: '/auth/register',
      payload: { username: 'winuser2', password: 'Win@2026ab' },
    });
    expect(response.statusCode).toBe(502);
    expect(response.json<{ detail: string }>().detail).toContain('Windows 账号同步失败');

    const count = await withSession(async (db) => {
      const rows = await db.db.select({ id: users.id }).from(users).where(eq(users.username, 'winuser2'));
      return rows.length;
    });
    expect(count).toBe(0);
  });

  it('同步关闭时注册成功且不连 Windows', async () => {
    overrideSettings({ windowsAccountSync: false });

    const response = await request(app, {
      method: 'POST',
      url: '/auth/register',
      payload: { username: 'winuser3', password: 'Winpass3' },
    });
    expect(response.statusCode).toBe(200);
    expect(sshState.calls).toEqual([]);
  });

  it('非法用户名 422 且不得触达 Windows', async () => {
    enableWindows();

    const response = await request(app, {
      method: 'POST',
      url: '/auth/register',
      payload: { username: 'bad name', password: 'Winpass1' },
    });
    expect(response.statusCode).toBe(422);
    expect(sshState.calls).toEqual([]);
  });
});

/* ============================================================
 * 集成：改密链路
 * ============================================================ */

describe('改密链路', () => {
  it('改密同步到 Windows；远端失败时平台密码保持不变', async () => {
    // 先在同步关闭状态下注册
    const registered = await request(app, {
      method: 'POST',
      url: '/auth/register',
      payload: { username: 'pwdwin', password: 'Oldpass1' },
    });
    expect(registered.statusCode).toBe(200);

    overrideSettings({ windowsAccountSync: true, sftpHost: '10.99.0.1', guacDbUrl: '' });

    const login = await request(app, {
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'pwdwin', password: 'Oldpass1' },
    });
    const headers = { authorization: `Bearer ${login.json<{ access_token: string }>().access_token}` };

    const changed = await request(app, {
      method: 'POST',
      url: '/auth/change-password',
      headers,
      payload: { old_password: 'Oldpass1', new_password: 'Newpass2' },
    });
    expect(changed.statusCode).toBe(200);

    const inner = decodePayload(sshState.calls[0]!.stdin);
    expect(inner).toContain("$username = 'pwdwin'");
    expect(inner).toContain("$password = 'Newpass2'");
    expect(inner).not.toContain('Oldpass1');

    // B2：改密后旧 JWT 立即失效，必须重新登录
    const relogin = await request(app, {
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'pwdwin', password: 'Newpass2' },
    });
    expect(relogin.statusCode).toBe(200);
    const newHeaders = {
      authorization: `Bearer ${relogin.json<{ access_token: string }>().access_token}`,
    };

    // 远端失败（新密码本身合规）
    sshState.exitCode = 1;
    sshState.err = '密码不满足复杂性要求';
    const failed = await request(app, {
      method: 'POST',
      url: '/auth/change-password',
      headers: newHeaders,
      payload: { old_password: 'Newpass2', new_password: 'New@9999' },
    });
    expect(failed.statusCode).toBe(502);

    // 原密码仍可登录（平台未改）
    const again = await request(app, {
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'pwdwin', password: 'Newpass2' },
    });
    expect(again.statusCode).toBe(200);
  });
});

/* ============================================================
 * C6/C5：密码过期策略与主机守卫
 * ============================================================ */

describe('C6 密码过期策略 / C5 主机守卫', () => {
  it('C6：默认遵循 Windows 密码过期策略', () => {
    const script = buildAccountScript('poluser', 'Passw0rd!');
    expect(script).toContain('-PasswordNeverExpires:$false');
  });

  it('C6：显式开启后脚本置 $true', () => {
    overrideSettings({ windowsPasswordNeverExpires: true });
    const script = buildAccountScript('poluser', 'Passw0rd!');
    expect(script).toContain('-PasswordNeverExpires:$true');
  });

  it('C5：sftp_host 为空时同步视为关闭', () => {
    overrideSettings({ windowsAccountSync: true, sftpHost: '' });
    expect(windowsSyncEnabled()).toBe(false);

    overrideSettings({ sftpHost: '10.99.0.1' });
    expect(windowsSyncEnabled()).toBe(true);
  });
});
