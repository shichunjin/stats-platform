/**
 * Proxmox Provider —— docs/multi-vm-desktop-plan.md 6.3
 *
 * 用假 fetch 锁住**调用契约**，这是本模块唯一值得测的东西：
 *  - clone 必须走 `nextid → clone → config`，且 cores/memory 只能出现在 config 里
 *    （clone API 没有这两个参数 —— 方案 A13，写错就静默用模板规格）
 *  - destroy 必须先停机再 DELETE（否则留下孤儿磁盘）
 *  - 非 2xx 必须变成带端点与状态码的 ProxmoxError，供 worker 判断可重试性
 */
import { describe, expect, it } from 'vitest';
import type { DesktopTemplate } from '../../src/db/schema.js';
import {
  ProxmoxError, createProxmoxProvider, type FetchLike,
} from '../../src/desktop/provider/proxmox.js';

interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly body: string | undefined;
}

interface Route {
  readonly status?: number;
  readonly data?: unknown;
  readonly raw?: string;
}

/** 按「方法 + URL 片段」派发的假 fetch；未命中返回 500 以便立刻暴露漏测 */
const makeFetch = (
  routes: Readonly<Record<string, Route>>,
  calls: Recorded[],
): FetchLike => async (url, init) => {
  calls.push({ method: init.method, url, body: init.body });
  const key = Object.keys(routes).find((pattern) => url.includes(pattern));
  const route = key === undefined ? undefined : routes[key];
  if (route === undefined) return { ok: false, status: 500, text: async () => 'no route' };
  const status = route.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => route.raw ?? JSON.stringify({ data: route.data ?? null }),
  };
};

const BASE = 'https://pve.example.com:8006';

const template: DesktopTemplate = {
  id: 1,
  code: 'win2022-stats-v1',
  name: '统计软件桌面 v1',
  osType: 'windows',
  osVersion: 'Windows Server 2022',
  provider: 'proxmox',
  providerRef: 'pve1/9001',
  providerNode: 'pve1',
  vcpu: 4,
  memoryMb: 8192,
  diskGb: 120,
  storage: 'local-lvm',
  networkBridge: null,
  vlanId: null,
  guestUsername: 'Administrator',
  softwareRegistryVer: null,
  loginScriptVer: null,
  status: 'active',
  isDefault: true,
  maxInstances: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const config = {
  apiUrl: BASE,
  tokenId: 'root@pam!dms',
  tokenSecret: 'secret',
  node: 'pve1',
  storage: 'local-lvm',
};

describe('clone：nextid → clone → config', () => {
  it('规格写在 config 而不是 clone（A13）', async () => {
    const calls: Recorded[] = [];
    const provider = createProxmoxProvider(config, makeFetch({
      '/cluster/nextid': { data: '9101' },
      '/clone': { data: 'UPID:pve1:0000' },
      '/config': { data: null },
    }, calls));

    const ref = await provider.clone(template, {
      name: 'DESK-alice', vcpu: 8, memoryMb: 16_384, staticIp: '10.20.3.11/16', gateway: '10.20.0.1',
    });

    expect(ref).toBe('pve1/9101');
    expect(calls.map((call) => `${call.method} ${call.url.replace(BASE, '')}`)).toEqual([
      'GET /api2/json/cluster/nextid',
      'POST /api2/json/nodes/pve1/qemu/9001/clone',
      'PUT /api2/json/nodes/pve1/qemu/9101/config',
    ]);

    const cloneBody = calls[1]!.body ?? '';
    expect(cloneBody).toContain('newid=9101');
    expect(cloneBody).toContain('full=false');
    expect(cloneBody).not.toContain('cores');

    const configBody = decodeURIComponent(calls[2]!.body ?? '');
    expect(configBody).toContain('cores=8');
    expect(configBody).toContain('memory=16384');
    expect(configBody).toContain('ip=10.20.3.11/16,gw=10.20.0.1');
  });

  it('不给静态 IP 时不写 ipconfig0（交给 Agent 回读）', async () => {
    const calls: Recorded[] = [];
    const provider = createProxmoxProvider(config, makeFetch({
      '/cluster/nextid': { data: '9102' },
      '/clone': {},
      '/config': {},
    }, calls));

    await provider.clone(template, { name: 'DESK-bob', vcpu: 2, memoryMb: 4096 });
    expect(decodeURIComponent(calls[2]!.body ?? '')).not.toContain('ipconfig0');
  });
});

describe('电源与销毁', () => {
  it('start 走 status/start', async () => {
    const calls: Recorded[] = [];
    const provider = createProxmoxProvider(config, makeFetch({ '/status/start': {} }, calls));
    await provider.start('pve1/9101');
    expect(calls[0]!.url).toContain('/nodes/pve1/qemu/9101/status/start');
  });

  it('suspend/reset 复用 status/{action}', async () => {
    const calls: Recorded[] = [];
    const provider = createProxmoxProvider(config, makeFetch({ '/status/': {} }, calls));
    await provider.power('pve1/9101', 'suspend');
    await provider.power('9101', 'reset');
    expect(calls[0]!.url).toContain('/status/suspend');
    // ref 不含节点时回落到配置的默认节点
    expect(calls[1]!.url).toContain('/nodes/pve1/qemu/9101/status/reset');
  });

  it('destroy：运行中先 stop，再带 purge 删除', async () => {
    const calls: Recorded[] = [];
    const provider = createProxmoxProvider(config, makeFetch({
      '/status/current': { data: { status: 'running' } },
      '/status/stop': {},
      '/qemu/9101?': {},
    }, calls));

    await provider.destroy('pve1/9101');

    const paths = calls.map((call) => call.url);
    expect(paths.some((url) => url.includes('/status/stop'))).toBe(true);
    const deleteCall = calls.find((call) => call.method === 'DELETE');
    expect(deleteCall?.url).toContain('purge=1');
  });

  it('shutdown 超时会抛错（调用方据此降级为硬 stop）', async () => {
    const provider = createProxmoxProvider(config, makeFetch({
      '/status/shutdown': {},
      '/status/current': { data: { status: 'running' } },
    }, []));

    await expect(provider.shutdown('pve1/9101', 1)).rejects.toThrow(ProxmoxError);
  });
});

describe('inspect / capacity / validateTemplate', () => {
  it('running 时回读 Agent 的 IPv4 与 agent ready', async () => {
    const provider = createProxmoxProvider(config, makeFetch({
      '/status/current': { data: { status: 'running' } },
      '/agent/network-get-interfaces': {
        data: {
          result: [
            { 'ip-addresses': [{ 'ip-address': '127.0.0.1', 'ip-address-type': 'ipv4' }] },
            { 'ip-addresses': [{ 'ip-address': '10.20.3.11', 'ip-address-type': 'ipv4' }] },
          ],
        },
      },
      '/agent/ping': {},
    }, []));

    expect(await provider.inspect('pve1/9101')).toEqual({
      powerState: 'running', primaryIp: '10.20.3.11', agentReady: true,
    });
  });

  it('Agent 不可用时 IP 为 null（不编造地址）', async () => {
    const provider = createProxmoxProvider(config, makeFetch({
      '/status/current': { data: { status: 'running' } },
      '/agent/network-get-interfaces': { status: 500, raw: 'agent error' },
      '/agent/ping': { status: 500, raw: 'agent error' },
    }, []));

    const state = await provider.inspect('pve1/9101');
    expect(state.primaryIp).toBeNull();
    expect(state.agentReady).toBe(false);
  });

  it('capacity 换算成 0~1 的占用率', async () => {
    const provider = createProxmoxProvider(config, makeFetch({
      '/nodes/pve1/status': {
        data: { cpu: 0.5, memory: { used: 8, total: 16 }, rootfs: { used: 250, total: 500 } },
      },
    }, []));

    expect(await provider.capacity()).toEqual({
      cpuUsage: 0.5, memUsage: 0.5, diskUsage: 0.5, freeIpCount: 0,
    });
  });

  it('validateTemplate 认 config 里的 template 标记', async () => {
    const ok = createProxmoxProvider(config, makeFetch({ '/config': { data: { template: 1 } } }, []));
    const bad = createProxmoxProvider(config, makeFetch({ '/config': { data: {} } }, []));

    expect(await ok.validateTemplate(template)).toBe(true);
    expect(await bad.validateTemplate(template)).toBe(false);
  });
});

describe('错误处理', () => {
  it('非 2xx 抛 ProxmoxError，带端点与状态码', async () => {
    const provider = createProxmoxProvider(config, makeFetch({ '/cluster/nextid': {} }, []));
    const failing = createProxmoxProvider(
      config,
      makeFetch({ '/status/start': { status: 403, raw: 'permission denied' } }, []),
    );

    // 未命中路由 = 500：顺带验证「Provider 出错会变成异常」而不是静默成功
    expect(await provider.capacity('pve1').catch(() => 'threw')).toBe('threw');

    const error = await failing.start('pve1/9101').catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ProxmoxError);
    expect((error as ProxmoxError).status).toBe(403);
    expect((error as ProxmoxError).endpoint).toContain('/status/start');
  });
});
