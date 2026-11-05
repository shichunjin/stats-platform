/**
 * Proxmox VE Provider —— docs/multi-vm-desktop-plan.md 6.3
 *
 * 用 Node 22 原生 `fetch` 直连 PVE REST API（`/api2/json`），不引 SDK：
 * 本模块只用到 8 个端点，SDK 带来的抽象成本大于收益。
 *
 * ⚠️ 三个必须先知道的事实（写调用方前必读）：
 *  1. `clone` **没有** cores/memory 参数。规格必须在 clone 之后、start 之前用
 *     `PUT /config` 写入；新克隆 VM 尚未启动过，因此 `clone → config → start`
 *     与「创建时指定规格」完全等价（方案 A13）。
 *  2. 运行中的 VM **不做热调整**（Windows 内存热加基本不可用，A14）。本模块的
 *     `config()` 只在 clone 之后被调用；要变规格请走 rebuild（销毁重建）。
 *  3. vmid 由 `/cluster/nextid` 分配（DMS 不自己算，避免并发撞号）。
 *
 * ref 约定：'<node>/<vmid>'（如 'pve1/9101'）；不含 '/' 时回落到配置的默认节点。
 */
import { getSettings } from '../../config/env.js';
import type { DesktopTemplate } from '../../db/schema.js';
import { aliyunConfigured, createAliyunEcsProvider, fingerprintOfEcs } from './aliyun-ecs.js';
import type { Capacity, DesktopProvider, PowerAction, VmSpec } from './types.js';

export interface ProxmoxConfig {
  readonly apiUrl: string;
  /** 'root@pam!dms' */
  readonly tokenId: string;
  readonly tokenSecret: string;
  readonly node: string;
  readonly storage?: string;
  readonly bridge?: string;
  readonly timeoutMs?: number;
}

/** Provider 调用失败。保留 HTTP 状态与端点，便于 worker 区分「可重试」与「配置错」。 */
export class ProxmoxError extends Error {
  readonly status: number;

  readonly endpoint: string;

  readonly detail: string;

  constructor(endpoint: string, status: number, detail: string) {
    super(`Proxmox ${endpoint} 失败（HTTP ${status}）：${detail}`);
    this.name = 'ProxmoxError';
    this.status = status;
    this.endpoint = endpoint;
    this.detail = detail;
  }
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

const DEFAULT_TIMEOUT_MS = 15_000;

/** 'pve1/9101' → { node, vmid }；'9101' → 配置默认节点 */
const splitRef = (ref: string, defaultNode: string): { node: string; vmid: string } => {
  const index = ref.indexOf('/');
  if (index === -1) return { node: defaultNode, vmid: ref };
  return { node: ref.slice(0, index), vmid: ref.slice(index + 1) };
};

const encode = (segment: string): string => encodeURIComponent(segment);

export const createProxmoxProvider = (
  config: ProxmoxConfig,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): DesktopProvider => {
  const base = config.apiUrl.replace(/\/+$/, '');
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const authHeaders = (): Record<string, string> => ({
    Authorization: `PVEAPIToken=${config.tokenId}=${config.tokenSecret}`,
  });

  const request = async (
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    form?: Readonly<Record<string, string | number | boolean>>,
  ): Promise<unknown> => {
    const hasBody = method !== 'GET' && method !== 'DELETE';
    const init: Parameters<FetchLike>[1] = {
      method,
      headers: authHeaders(),
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (hasBody) {
      init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      init.body = new URLSearchParams(
        Object.entries(form ?? {}).map(([key, value]) => [key, String(value)]),
      ).toString();
    }

    const response = await fetchImpl(`${base}/api2/json${path}`, init);
    const raw = await response.text();
    if (!response.ok) throw new ProxmoxError(path, response.status, raw.slice(0, 500));

    // 204/空响应（部分 DELETE 无 body）
    if (raw.trim() === '') return null;
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && 'data' in parsed) {
      return (parsed as { data: unknown }).data;
    }
    return parsed;
  };

  /** /cluster/nextid：让 PVE 分配空闲 vmid，避免 DMS 自己算号撞车 */
  const nextId = async (): Promise<number> => {
    const data = await request('GET', '/cluster/nextid');
    return Number(data);
  };

  const readPowerState = async (node: string, vmid: string): Promise<'running' | 'stopped' | 'suspended' | 'unknown'> => {
    const data = await request('GET', `/nodes/${encode(node)}/qemu/${encode(vmid)}/status/current`);
    const status = (data as { status?: string } | null)?.status ?? 'unknown';
    if (status === 'running') return 'running';
    if (status === 'stopped') return 'stopped';
    if (status === 'suspended' || status === 'paused') return 'suspended';
    return 'unknown';
  };

  /** 从 Guest Agent 读第一个非回环 IPv4；Agent 不可用返回 null（此时依赖 IPAM 静态 IP） */
  const readAgentIp = async (node: string, vmid: string): Promise<string | null> => {
    try {
      const data = await request('GET', `/nodes/${encode(node)}/qemu/${encode(vmid)}/agent/network-get-interfaces`);
      const result = (data as { result?: readonly { 'ip-addresses'?: readonly { 'ip-address'?: string; 'ip-address-type'?: string }[] }[] } | null)?.result ?? [];
      for (const iface of result) {
        for (const addr of iface['ip-addresses'] ?? []) {
          const ip = addr['ip-address'];
          if (ip && addr['ip-address-type'] === 'ipv4' && !ip.startsWith('127.')) return ip;
        }
      }
      return null;
    } catch {
      return null;
    }
  };

  const agentReady = async (node: string, vmid: string): Promise<boolean> => {
    try {
      await request('POST', `/nodes/${encode(node)}/qemu/${encode(vmid)}/agent/ping`);
      return true;
    } catch {
      return false;
    }
  };

  return {
    kind: 'proxmox',

    async validateTemplate(template: DesktopTemplate): Promise<boolean> {
      const { node, vmid } = splitRef(template.providerRef, template.providerNode ?? config.node);
      try {
        const data = await request('GET', `/nodes/${encode(node)}/qemu/${encode(vmid)}/config`);
        // PVE 把模板标记写在 config 里（template=1）；未标记为模板时克隆行为不可预期
        return (data as { template?: number | string } | null)?.template !== undefined;
      } catch {
        return false;
      }
    },

    async clone(template: DesktopTemplate, spec: VmSpec): Promise<string> {
      const { node: tplNode, vmid: tplVmid } = splitRef(
        template.providerRef, template.providerNode ?? config.node,
      );
      const vmid = await nextId();
      const target = spec.targetNode ?? config.node;

      // ① 链接克隆（full=0）：秒级，共享模板磁盘的 base image
      await request('POST', `/nodes/${encode(tplNode)}/qemu/${encode(tplVmid)}/clone`, {
        newid: vmid,
        name: spec.name,
        full: false,
        target,
        ...(spec.storage ?? config.storage ? { storage: spec.storage ?? config.storage! } : {}),
      });

      // ② 写规格（A13：clone API 没有 cores/memory 参数，必须这一步）
      //    ipconfig0 仅在静态 IP 方案下写入，省掉等 Agent 回读地址的时间
      const configForm: Record<string, string | number> = {
        cores: spec.vcpu,
        memory: spec.memoryMb,
        name: spec.name,
      };
      if (spec.staticIp) {
        const gateway = spec.gateway ? `,gw=${spec.gateway}` : '';
        configForm.ipconfig0 = `ip=${spec.staticIp}${gateway}`;
      }
      if (spec.storage ?? config.storage) configForm.storage = spec.storage ?? config.storage!;
      await request('PUT', `/nodes/${encode(target)}/qemu/${encode(String(vmid))}/config`, configForm);

      return `${target}/${vmid}`;
    },

    async start(ref: string): Promise<void> {
      const { node, vmid } = splitRef(ref, config.node);
      await request('POST', `/nodes/${encode(node)}/qemu/${encode(vmid)}/status/start`);
    },

    async power(ref: string, action: PowerAction): Promise<void> {
      const { node, vmid } = splitRef(ref, config.node);
      await request('POST', `/nodes/${encode(node)}/qemu/${encode(vmid)}/status/${action}`);
    },

    /** 优雅关机 + 轮询；超时抛错（调用方降级为硬 stop —— 方案 9.10） */
    async shutdown(ref: string, timeoutMsLimit: number): Promise<void> {
      const { node, vmid } = splitRef(ref, config.node);
      await request('POST', `/nodes/${encode(node)}/qemu/${encode(vmid)}/status/shutdown`);

      const deadline = Date.now() + timeoutMsLimit;
      const pollIntervalMs = 2_000;
      // 轮询而非 sleep 固定时长：Guest Agent 正常时几秒就停，没必要白等
      for (;;) {
        const state = await readPowerState(node, vmid);
        if (state === 'stopped') return;
        if (Date.now() >= deadline) {
          throw new ProxmoxError(`status/shutdown(${ref})`, 504, `优雅关机超时 ${timeoutMsLimit}ms`);
        }
        await new Promise((resolve) => { setTimeout(resolve, pollIntervalMs).unref?.(); });
      }
    },

    async destroy(ref: string): Promise<void> {
      const { node, vmid } = splitRef(ref, config.node);
      // 先确保停机：PVE 对运行中的 VM 直接 DELETE 会失败，且会留下孤儿磁盘
      if (await readPowerState(node, vmid) !== 'stopped') {
        await request('POST', `/nodes/${encode(node)}/qemu/${encode(vmid)}/status/stop`);
      }
      await request(
        'DELETE',
        `/nodes/${encode(node)}/qemu/${encode(vmid)}?purge=1&destroy-unreferenced-disks=1`,
      );
    },

    async inspect(ref: string): Promise<{
      readonly powerState: 'running' | 'stopped' | 'suspended' | 'unknown';
      readonly primaryIp: string | null;
      readonly agentReady: boolean;
    }> {
      const { node, vmid } = splitRef(ref, config.node);
      const powerState = await readPowerState(node, vmid);
      if (powerState !== 'running') {
        return { powerState, primaryIp: null, agentReady: false };
      }
      return {
        powerState,
        primaryIp: await readAgentIp(node, vmid),
        agentReady: await agentReady(node, vmid),
      };
    },

    async snapshot(ref: string, name: string): Promise<string> {
      const { node, vmid } = splitRef(ref, config.node);
      await request('POST', `/nodes/${encode(node)}/qemu/${encode(vmid)}/snapshot`, { snapname: name });
      return name;
    },

    /**
     * 宿主水位。freeIpCount 恒为 0 —— Provider 不知道 IPAM，DMS 侧合并自己的水位后再判断。
     */
    async capacity(node?: string): Promise<Capacity> {
      const target = node ?? config.node;
      const data = await request('GET', `/nodes/${encode(target)}/status`);
      const row = (data as {
        cpu?: number; memory?: { used?: number; total?: number };
        rootfs?: { used?: number; total?: number };
      } | null) ?? {};
      const memTotal = row.memory?.total ?? 0;
      const diskTotal = row.rootfs?.total ?? 0;
      return {
        cpuUsage: row.cpu ?? 0,
        memUsage: memTotal > 0 ? (row.memory?.used ?? 0) / memTotal : 0,
        diskUsage: diskTotal > 0 ? (row.rootfs?.used ?? 0) / diskTotal : 0,
        freeIpCount: 0,
      };
    },
  };
};

/* ---------------- 工厂：按 settings 构造，按配置指纹缓存 ---------------- */

let cached: { fingerprint: string; provider: DesktopProvider } | null = null;

const fingerprintOf = (settings: ReturnType<typeof getSettings>): string => {
  // ECS 分派：指纹覆盖全部 aliyun 配置，任一变更都会重建 provider
  if (settings.desktopProvider === 'ecs') return fingerprintOfEcs(settings);
  return [
    settings.proxmoxApiUrl, settings.proxmoxTokenId, settings.proxmoxNode,
    settings.proxmoxStorage, settings.proxmoxBridge, String(settings.proxmoxTimeoutMs),
  ].join('|');
};

/**
 * 按 settings 取 Provider；未配置（缺凭证/端点）时返回 null —— 调用方据此
 * 决定「拒绝服务」还是「走老 RDS 路径」，不要在这里抛错（会阻断整个平台启动）。
 * desktopProvider=ecs 时校验 aliyun* 五个必填项（fail-fast，缺一返回 null）。
 */
export const getDesktopProvider = (
  settings: ReturnType<typeof getSettings> = getSettings(),
): DesktopProvider | null => {
  // 注入的替身优先：测试里没有真 Proxmox/ECS，若不优先就会拿到 null 而误判「未配置」
  if (cached !== null && cached.fingerprint.startsWith('<injected:')) return cached.provider;

  if (settings.desktopProvider === 'ecs') {
    if (!aliyunConfigured(settings)) return null;

    const fingerprint = fingerprintOf(settings);
    if (cached?.fingerprint === fingerprint) return cached.provider;

    const provider = createAliyunEcsProvider({
      accessKeyId: settings.aliyunAccessKeyId,
      accessKeySecret: settings.aliyunAccessKeySecret,
      regionId: settings.aliyunRegionId,
      vswitchId: settings.aliyunVswitchId,
      securityGroupId: settings.aliyunSecurityGroupId,
      instanceType: settings.aliyunInstanceType,
      ...(settings.aliyunInitialPassword === '' ? {} : { initialPassword: settings.aliyunInitialPassword }),
      ...(settings.aliyunSystemDiskCategory === '' ? {} : { systemDiskCategory: settings.aliyunSystemDiskCategory }),
      stopCharging: settings.aliyunStopCharging,
      allocatePublicIp: settings.aliyunAllocatePublicIp,
      timeoutMs: settings.aliyunTimeoutMs,
    });
    cached = { fingerprint, provider };
    return provider;
  }

  if (settings.proxmoxApiUrl === '' || settings.proxmoxTokenId === '') return null;

  const fingerprint = fingerprintOf(settings);
  if (cached?.fingerprint === fingerprint) return cached.provider;

  const provider = createProxmoxProvider({
    apiUrl: settings.proxmoxApiUrl,
    tokenId: settings.proxmoxTokenId,
    tokenSecret: settings.proxmoxTokenSecret,
    node: settings.proxmoxNode,
    ...(settings.proxmoxStorage === '' ? {} : { storage: settings.proxmoxStorage }),
    ...(settings.proxmoxBridge === '' ? {} : { bridge: settings.proxmoxBridge }),
    timeoutMs: settings.proxmoxTimeoutMs,
  });
  cached = { fingerprint, provider };
  return provider;
};

/** 测试钩子：注入替身 Provider（对应 Python 的 monkeypatch） */
export const setDesktopProvider = (provider: DesktopProvider | null): void => {
  cached = provider === null ? null : { fingerprint: `<injected:${provider.kind}>`, provider };
};

export const resetDesktopProvider = (): void => {
  cached = null;
};
