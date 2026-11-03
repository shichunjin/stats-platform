/**
 * 阿里云 ECS Provider —— docs/multi-vm-desktop-plan.md 6.3（公有云分支）
 *
 * 零依赖实现 ACS3-HMAC-SHA256 签名（V3 签名，官方文档「RPC API 签名机制」），
 * 不引官方 SDK：本模块只用到 8 个 Action，SDK 的抽象成本大于收益。
 *
 * 与 Proxmox 实现的语义对齐（写调用方前必读）：
 *  - ref = ECS instanceId（'i-xxx'）；模板 providerRef = 自定义镜像 ID（'m-xxx'）。
 *  - RunInstances 创建即定规格（不存在「克隆后补配置」），返回时实例为 Stopped，
 *    start 由调用方在账号注入之后决定 —— 与接口契约一致。
 *  - ECS 没有「挂起」：suspend 映射为节省停机（StoppedMode=StopCharging，按量
 *    停机不收费），账号未开启该能力时配置 aliyunStopCharging=false 走普通停机。
 *  - inspect 的 agentReady 恒为 true：ECS 没有 qemu-guest-agent，Guest 是否可用
 *    由 DMS 的 3389 探活任务负责，这里不重复探测。
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { getSettings } from '../../config/env.js';
import type { DesktopTemplate } from '../../db/schema.js';
import type { Capacity, DesktopProvider, PowerAction, VmSpec } from './types.js';

export interface AliyunEcsConfig {
  readonly accessKeyId: string;
  readonly accessKeySecret: string;
  readonly regionId: string;
  readonly vswitchId: string;
  readonly securityGroupId: string;
  readonly instanceType: string;
  /** 创建实例的初始密码（空 = 不传，镜像内置账号接管） */
  readonly initialPassword?: string;
  readonly systemDiskCategory?: string;
  readonly stopCharging: boolean;
  readonly timeoutMs?: number;
}

export class AliyunEcsError extends Error {
  readonly action: string;

  readonly requestId: string;

  readonly detail: string;

  constructor(action: string, requestId: string, detail: string) {
    super(`阿里云 ECS ${action} 失败：${detail}`);
    this.name = 'AliyunEcsError';
    this.action = action;
    this.requestId = requestId;
    this.detail = detail;
  }
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

const DEFAULT_TIMEOUT_MS = 15_000;
/** 空请求体的 SHA-256（ACS3 规范要求 payload 哈希参与签名，GET 请求 body 为空） */
const EMPTY_BODY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** ACS3 规范的 percentEncode：RFC3986，`~` 不编码，`+`→`%20`，`*`→`%2A` */
const percentEncode = (value: string): string =>
  encodeURIComponent(value).replace(/\+/g, '%20').replace(/\*/g, '%2A').replace(/%7E/g, '~');

const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex');

/** 嵌套对象参数（如 SystemDisk.Category、PrivateIpAddress）按 ECS RPC 约定打平成点分键 */
const flattenParams = (
  params: Readonly<Record<string, string | number | boolean | undefined>>,
): Record<string, string> => {
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') flat[key] = String(value);
  }
  return flat;
};

export const createAliyunEcsProvider = (
  config: AliyunEcsConfig,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): DesktopProvider => {
  const host = `ecs.${config.regionId}.aliyuncs.com`;
  const endpoint = `https://${host}/`;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  /** 发起一次 ACS3 签名的 RPC 调用（全部走 GET，参数在 query string） */
  const call = async (
    action: string,
    params: Readonly<Record<string, string | number | boolean | undefined>> = {},
  ): Promise<Record<string, unknown>> => {
    const query = flattenParams({ Action: action, ...params });
    const canonicalQuery = Object.keys(query)
      .sort()
      .map((key) => `${percentEncode(key)}=${percentEncode(query[key]!)}`)
      .join('&');

    const acsDate = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const headers: Record<string, string> = {
      host,
      'x-acs-action': action,
      'x-acs-version': '2014-05-26',
      'x-acs-date': acsDate,
      'x-acs-signature-nonce': randomUUID(),
    };
    const signedNames = Object.keys(headers).sort();
    const canonicalHeaders = signedNames.map((name) => `${name}:${headers[name]!}\n`).join('');

    const canonicalRequest = [
      'GET', '/', canonicalQuery, canonicalHeaders, signedNames.join(';'), EMPTY_BODY_SHA256,
    ].join('\n');
    const stringToSign = `ACS3-HMAC-SHA256\n${sha256Hex(canonicalRequest)}`;
    const signature = createHmac('sha256', config.accessKeySecret).update(stringToSign).digest('hex');

    const response = await fetchImpl(`${endpoint}?${canonicalQuery}`, {
      method: 'GET',
      headers: {
        Authorization: `ACS3-HMAC-SHA256 Credential=${config.accessKeyId}, `
          + `SignedHeaders=${signedNames.join(';')}, Signature=${signature}`,
        ...Object.fromEntries(signedNames.filter((name) => name !== 'host').map((name) => [name, headers[name]!])),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    const raw = await response.text();
    let parsed: Record<string, unknown> = {};
    try {
      // JSON null（空响应）也归一成空对象，调用方的字段访问不会炸
      const value: unknown = JSON.parse(raw);
      if (value !== null && typeof value === 'object') parsed = value as Record<string, unknown>;
    } catch {
      // 非 JSON 响应（网关 502 等）——保留原文前 500 字符供排查
    }
    if (!response.ok) {
      throw new AliyunEcsError(
        action,
        String(parsed.RequestId ?? ''),
        `HTTP ${response.status}：${String(parsed.Message ?? raw.slice(0, 500))}`,
      );
    }
    return parsed;
  };

  /** DescribeInstances 单实例查询；实例不存在（已释放）返回 null */
  const describeInstance = async (
    ref: string,
  ): Promise<{ status: string; privateIp: string | null } | null> => {
    const data = await call('DescribeInstances', {
      RegionId: config.regionId,
      InstanceIds: JSON.stringify([ref]),
    });
    const instances = (data.Instances as { Instance?: readonly Record<string, unknown>[] } | undefined)?.Instance ?? [];
    const first = instances[0];
    if (first === undefined) return null;
    const vpc = first.VpcAttributes as { PrivateIpAddress?: { IpAddress?: readonly string[] } } | undefined;
    const privateIp = vpc?.PrivateIpAddress?.IpAddress?.[0] ?? null;
    return { status: String(first.Status ?? ''), privateIp };
  };

  /** 轮询直至实例进入期望状态或超时（deadline 语义与 Proxmox.shutdown 一致） */
  const waitStatus = async (
    ref: string,
    expect: readonly string[],
    deadlineMs: number,
    pollIntervalMs = 3_000,
  ): Promise<void> => {
    for (;;) {
      const instance = await describeInstance(ref);
      if (instance !== null && expect.includes(instance.status)) return;
      if (Date.now() >= deadlineMs) {
        throw new AliyunEcsError(
          'DescribeInstances', '',
          `等待 ${ref} 进入 ${expect.join('/')} 超时（当前：${instance?.status ?? '已释放'}）`,
        );
      }
      await new Promise((resolve) => { setTimeout(resolve, pollIntervalMs).unref?.(); });
    }
  };

  const ensureStopped = async (ref: string, force: boolean): Promise<void> => {
    const instance = await describeInstance(ref);
    if (instance === null) return;
    if (instance.status === 'Stopped') return;
    await call('StopInstance', { RegionId: config.regionId, InstanceId: ref, ForceStop: force });
    await waitStatus(ref, ['Stopped'], Date.now() + 120_000);
  };

  return {
    kind: 'ecs',

    /** 模板 providerRef = 自定义镜像 ID；镜像 Available 才能创建实例 */
    async validateTemplate(template: DesktopTemplate): Promise<boolean> {
      try {
        const data = await call('DescribeImages', {
          RegionId: config.regionId,
          ImageId: template.providerRef,
        });
        const images = (data.Images as { Image?: readonly Record<string, unknown>[] } | undefined)?.Image ?? [];
        return images[0]?.Status === 'Available';
      } catch {
        return false;
      }
    },

    /**
     * RunInstances 创建按量实例。创建即定规格（InstanceType/系统盘），无需克隆后补配置；
     * 返回时实例尚未开机（start 由调用方决定，与接口契约一致）。
     * 静态 IP：RunInstances 支持 PrivateIpAddress（必须落在 vSwitch 网段内），省掉
     * 等 Guest 起来再回读地址的环节。
     */
    async clone(template: DesktopTemplate, spec: VmSpec): Promise<string> {
      const data = await call('RunInstances', {
        RegionId: config.regionId,
        ImageId: template.providerRef,
        InstanceType: config.instanceType,
        SecurityGroupId: config.securityGroupId,
        VSwitchId: config.vswitchId,
        InstanceName: spec.name,
        InstanceChargeType: 'PostPaid',
        Amount: 1,
        ...(config.initialPassword === '' ? {} : { Password: config.initialPassword }),
        ...(spec.staticIp === undefined ? {} : { PrivateIpAddress: spec.staticIp }),
        ...(config.systemDiskCategory === undefined || config.systemDiskCategory === ''
          ? {}
          : { 'SystemDisk.Category': config.systemDiskCategory }),
      });
      const ids = data.InstanceIdSets as readonly string[] | undefined;
      const instanceId = ids?.[0];
      if (instanceId === undefined) {
        throw new AliyunEcsError('RunInstances', String(data.RequestId ?? ''), '响应缺少 InstanceIdSets');
      }
      return instanceId;
    },

    async start(ref: string): Promise<void> {
      await call('StartInstance', { RegionId: config.regionId, InstanceId: ref });
    },

    async power(ref: string, action: PowerAction): Promise<void> {
      switch (action) {
        case 'start':
          await call('StartInstance', { RegionId: config.regionId, InstanceId: ref });
          return;
        case 'stop':
          // ForceStop=true：Windows 未优雅关机也硬停（调用方已决定要停）
          await call('StopInstance', {
            RegionId: config.regionId, InstanceId: ref, ForceStop: true,
          });
          return;
        case 'suspend':
          // ECS 无挂起：映射为节省停机（按量停机不收费）；账号未开启时改普通停机
          if (config.stopCharging) {
            await call('StopInstance', {
              RegionId: config.regionId, InstanceId: ref, StoppedMode: 'StopCharging',
            });
          } else {
            await call('StopInstance', {
              RegionId: config.regionId, InstanceId: ref, ForceStop: true,
            });
          }
          return;
        case 'reset':
          await call('RebootInstance', {
            RegionId: config.regionId, InstanceId: ref, ForceReboot: true,
          });
          return;
        default: {
          const exhaustive: never = action;
          throw new AliyunEcsError('power', '', `未知电源动作：${String(exhaustive)}`);
        }
      }
    },

    /** 优雅停机 + 轮询；超时抛错（调用方降级为 power(ref,'stop') —— 方案 9.10） */
    async shutdown(ref: string, timeoutMsLimit: number): Promise<void> {
      await call('StopInstance', { RegionId: config.regionId, InstanceId: ref, ForceStop: false });
      await waitStatus(ref, ['Stopped'], Date.now() + timeoutMsLimit);
    },

    /** 先确保停机再 DeleteInstance（Force），与 Proxmox.destroy 的「先停后删」一致 */
    async destroy(ref: string): Promise<void> {
      await ensureStopped(ref, true);
      await call('DeleteInstance', { RegionId: config.regionId, InstanceId: ref, Force: true });
    },

    async inspect(ref: string): Promise<{
      readonly powerState: 'running' | 'stopped' | 'suspended' | 'unknown';
      readonly primaryIp: string | null;
      readonly agentReady: boolean;
    }> {
      const instance = await describeInstance(ref);
      if (instance === null) {
        return { powerState: 'unknown', primaryIp: null, agentReady: false };
      }
      let powerState: 'running' | 'stopped' | 'unknown' = 'unknown';
      if (instance.status === 'Running') powerState = 'running';
      if (instance.status === 'Stopped') powerState = 'stopped';
      return {
        powerState,
        primaryIp: instance.privateIp,
        // ECS 没有 qemu-guest-agent；Guest 可用性由 DMS 的 3389 探活任务负责
        agentReady: true,
      };
    },

    /** 回收前快照（失败销毁路径的恢复点）：系统盘 CreateSnapshot，返回 snapshotId */
    async snapshot(ref: string, name: string): Promise<string> {
      const data = await call('DescribeDisks', {
        RegionId: config.regionId, InstanceId: ref, DiskType: 'system',
      });
      const disks = (data.Disks as { Disk?: readonly Record<string, unknown>[] } | undefined)?.Disk ?? [];
      const diskId = disks[0]?.DiskId;
      if (typeof diskId !== 'string') {
        throw new AliyunEcsError('DescribeDisks', String(data.RequestId ?? ''), `实例 ${ref} 未找到系统盘`);
      }
      const snap = await call('CreateSnapshot', {
        RegionId: config.regionId, DiskId: diskId, SnapshotName: name.slice(0, 127),
      });
      return String(snap.SnapshotId ?? '');
    },

    /**
     * ECS 无「宿主池」概念，水位恒为 0 —— 付费容量由账号配额决定，
     * DMS 侧以 IPAM 可用 IP 数 + 每日时长配额做分配校验，不做双份判断。
     */
    async capacity(): Promise<Capacity> {
      return { cpuUsage: 0, memUsage: 0, diskUsage: 0, freeIpCount: 0 };
    },
  };
};

/* ---------------- 工厂：按 settings 构造，按配置指纹缓存 ---------------- */

export const aliyunConfigured = (settings: ReturnType<typeof getSettings>): boolean =>
  settings.desktopProvider === 'ecs'
  && settings.aliyunAccessKeyId !== ''
  && settings.aliyunAccessKeySecret !== ''
  && settings.aliyunRegionId !== ''
  && settings.aliyunVswitchId !== ''
  && settings.aliyunSecurityGroupId !== ''
  && settings.aliyunInstanceType !== '';

export const fingerprintOfEcs = (settings: ReturnType<typeof getSettings>): string => [
  settings.desktopProvider,
  settings.aliyunAccessKeyId, settings.aliyunAccessKeySecret, settings.aliyunRegionId,
  settings.aliyunVswitchId, settings.aliyunSecurityGroupId, settings.aliyunInstanceType,
  settings.aliyunInitialPassword, settings.aliyunSystemDiskCategory,
  String(settings.aliyunStopCharging), String(settings.aliyunTimeoutMs),
].join('|');
