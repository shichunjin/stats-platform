/**
 * 阿里云 ECS Provider —— docs/multi-vm-desktop-plan.md 6.3（公有云分支）
 *
 * 用假 fetch 锁住调用契约（与 desktop-provider.test.ts 同一套路）：
 *  - clone = RunInstances：创建即定规格，Amount=1，静态 IP 走 PrivateIpAddress
 *  - destroy 必须「先停再删」（与 Proxmox 一致）；已停机不重复 StopInstance
 *  - suspend 映射节省停机（StoppedMode=StopCharging），账号未开启时退化为硬停
 *  - 非 2xx 必须变成带 Action/RequestId 的 AliyunEcsError
 *  - 签名头必须存在且格式正确（值不校验，校验在联调时用真实 AK 做）
 */
import { describe, expect, it, vi } from 'vitest';
import type { DesktopTemplate } from '../../src/db/schema.js';
import {
  AliyunEcsError, createAliyunEcsProvider, type FetchLike,
} from '../../src/desktop/provider/aliyun-ecs.js';

interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly authorization: string;
}

interface Route {
  readonly status?: number;
  readonly data?: unknown;
  readonly raw?: string;
}

type RouteOrQueue = Route | Route[];

/** 按「URL 里的 Action=xxx」派发；数组路由按次序弹出（测轮询用），未命中返回 500 */
const makeFetch = (
  routes: Readonly<Record<string, RouteOrQueue>>,
  calls: Recorded[],
): FetchLike => {
  const queues = new Map<string, Route[]>();
  for (const [action, entry] of Object.entries(routes)) {
    queues.set(action, Array.isArray(entry) ? [...entry] : [entry]);
  }
  return async (url, init) => {
    calls.push({ method: init.method, url, authorization: init.headers.Authorization ?? '' });
    const action = new URL(url).searchParams.get('Action') ?? '';
    const queue = queues.get(action);
    if (queue === undefined) return { ok: false, status: 500, text: async () => `no route: ${action}` };
    const route = queue.shift() ?? { data: null };
    const status = route.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => route.raw ?? JSON.stringify(route.data ?? null),
    };
  };
};

const config = {
  accessKeyId: 'LTAI-test-key',
  accessKeySecret: 'test-secret',
  regionId: 'cn-hangzhou',
  vswitchId: 'vsw-1',
  securityGroupId: 'sg-1',
  instanceType: 'ecs.g6.xlarge',
  initialPassword: 'Init#Passw0rd',
  systemDiskCategory: 'cloud_essd',
  stopCharging: true,
};

const template: DesktopTemplate = {
  id: 1,
  code: 'win2022-stats-v1',
  name: '统计软件桌面 v1',
  osType: 'windows',
  osVersion: 'Windows Server 2022',
  provider: 'ecs',
  providerRef: 'm-win2022-stats',
  providerNode: null,
  vcpu: 4,
  memoryMb: 8192,
  diskGb: 120,
  storage: null,
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

const paramsOf = (call: Recorded): URLSearchParams => new URL(call.url).searchParams;

describe('clone：RunInstances 创建即定规格', () => {
  it('镜像/规格/静态 IP/初始密码一次写齐', async () => {
    const calls: Recorded[] = [];
    const provider = createAliyunEcsProvider(config, makeFetch({
      RunInstances: { data: { InstanceIdSets: ['i-abc123'], RequestId: 'r-1' } },
    }, calls));

    const ref = await provider.clone(template, {
      name: 'DESK-alice', vcpu: 4, memoryMb: 8192, staticIp: '172.25.3.11',
    });

    expect(ref).toBe('i-abc123');
    const params = paramsOf(calls[0]!);
    expect(params.get('Action')).toBe('RunInstances');
    expect(params.get('ImageId')).toBe('m-win2022-stats');
    expect(params.get('InstanceType')).toBe('ecs.g6.xlarge');
    expect(params.get('VSwitchId')).toBe('vsw-1');
    expect(params.get('SecurityGroupId')).toBe('sg-1');
    expect(params.get('InstanceName')).toBe('DESK-alice');
    expect(params.get('InstanceChargeType')).toBe('PostPaid');
    expect(params.get('Amount')).toBe('1');
    expect(params.get('PrivateIpAddress')).toBe('172.25.3.11');
    expect(params.get('Password')).toBe('Init#Passw0rd');
    expect(params.get('SystemDisk.Category')).toBe('cloud_essd');
  });

  it('不给静态 IP / 不配初始密码时不写对应参数', async () => {
    const calls: Recorded[] = [];
    const provider = createAliyunEcsProvider(
      { ...config, initialPassword: '' },
      makeFetch({ RunInstances: { data: { InstanceIdSets: ['i-2'] } } }, calls),
    );

    await provider.clone(template, { name: 'DESK-bob', vcpu: 2, memoryMb: 4096 });
    expect(paramsOf(calls[0]!).get('PrivateIpAddress')).toBeNull();
    expect(paramsOf(calls[0]!).get('Password')).toBeNull();
    // 默认（同 VPC 私网部署）不分配公网 IP
    expect(paramsOf(calls[0]!).get('AllocatePublicIpAddress')).toBeNull();
  });

  it('allocatePublicIp=true 时 RunInstances 带 AllocatePublicIpAddress=true（guacd 在 VPC 外）', async () => {
    const calls: Recorded[] = [];
    const provider = createAliyunEcsProvider(
      { ...config, allocatePublicIp: true },
      makeFetch({ RunInstances: { data: { InstanceIdSets: ['i-3'] } } }, calls),
    );

    await provider.clone(template, { name: 'DESK-carol', vcpu: 4, memoryMb: 8192 });
    expect(paramsOf(calls[0]!).get('AllocatePublicIpAddress')).toBe('true');
  });
});

describe('电源动作', () => {
  it('start/reset 直接映射 StartInstance/RebootInstance', async () => {
    const calls: Recorded[] = [];
    const provider = createAliyunEcsProvider(config, makeFetch({
      StartInstance: { data: {} }, RebootInstance: { data: {} },
    }, calls));

    await provider.start('i-1');
    await provider.power('i-1', 'reset');
    expect(paramsOf(calls[0]!).get('Action')).toBe('StartInstance');
    expect(paramsOf(calls[1]!).get('Action')).toBe('RebootInstance');
    expect(paramsOf(calls[1]!).get('ForceReboot')).toBe('true');
  });

  it('suspend：stopCharging=true 走节省停机，false 退化为硬停', async () => {
    const calls: Recorded[] = [];
    const charging = createAliyunEcsProvider(config, makeFetch({ StopInstance: { data: {} } }, calls));
    const plain = createAliyunEcsProvider(
      { ...config, stopCharging: false },
      makeFetch({ StopInstance: { data: {} } }, calls),
    );

    await charging.power('i-1', 'suspend');
    expect(paramsOf(calls[0]!).get('StoppedMode')).toBe('StopCharging');

    await plain.power('i-1', 'suspend');
    expect(paramsOf(calls[1]!).get('ForceStop')).toBe('true');
    expect(paramsOf(calls[1]!).get('StoppedMode')).toBeNull();
  });
});

describe('destroy：先停再删', () => {
  it('运行中：StopInstance(ForceStop) → 轮询 Stopped → DeleteInstance(Force)', async () => {
    const calls: Recorded[] = [];
    const provider = createAliyunEcsProvider(config, makeFetch({
      DescribeInstances: [
        { data: { Instances: { Instance: [{ Status: 'Running', VpcAttributes: { PrivateIpAddress: { IpAddress: ['172.25.3.11'] } } }] } } },
        { data: { Instances: { Instance: [{ Status: 'Stopped' }] } } },
      ],
      StopInstance: { data: {} },
      DeleteInstance: { data: {} },
    }, calls));

    await provider.destroy('i-1');

    const actions = calls.map((call) => paramsOf(call).get('Action'));
    expect(actions).toEqual(['DescribeInstances', 'StopInstance', 'DescribeInstances', 'DeleteInstance']);
    expect(paramsOf(calls[1]!).get('ForceStop')).toBe('true');
    expect(paramsOf(calls[3]!).get('Force')).toBe('true');
  });

  it('已停机：不重复 StopInstance', async () => {
    const calls: Recorded[] = [];
    const provider = createAliyunEcsProvider(config, makeFetch({
      DescribeInstances: { data: { Instances: { Instance: [{ Status: 'Stopped' }] } } },
      DeleteInstance: { data: {} },
    }, calls));

    await provider.destroy('i-1');
    expect(calls.map((call) => paramsOf(call).get('Action'))).toEqual(['DescribeInstances', 'DeleteInstance']);
  });

  it('实例不存在（已释放）：幂等跳过', async () => {
    const calls: Recorded[] = [];
    const provider = createAliyunEcsProvider(config, makeFetch({
      DescribeInstances: { data: { Instances: { Instance: [] } } },
      DeleteInstance: { data: {} },
    }, calls));

    await provider.destroy('i-gone');
    expect(calls.map((call) => paramsOf(call).get('Action'))).toEqual(['DescribeInstances', 'DeleteInstance']);
  });
});

describe('inspect', () => {
  it('Running 映射 running + 私网 IP，agentReady 恒 true', async () => {
    const calls: Recorded[] = [];
    const provider = createAliyunEcsProvider(config, makeFetch({
      DescribeInstances: {
        data: { Instances: { Instance: [{ Status: 'Running', VpcAttributes: { PrivateIpAddress: { IpAddress: ['172.25.3.11'] } } }] } },
      },
    }, calls));

    expect(await provider.inspect('i-1')).toEqual({
      powerState: 'running', primaryIp: '172.25.3.11', agentReady: true,
    });
    // InstanceIds 必须是 JSON 数组（DescribeInstances 的数组参数约定）
    expect(paramsOf(calls[0]!).get('InstanceIds')).toBe('["i-1"]');
  });

  it('Stopped 映射 stopped、IP 为 null；实例不存在映射 unknown/false', async () => {
    const calls: Recorded[] = [];
    const provider = createAliyunEcsProvider(config, makeFetch({
      DescribeInstances: { data: { Instances: { Instance: [{ Status: 'Stopped' }] } } },
    }, calls));

    expect(await provider.inspect('i-1')).toEqual({
      powerState: 'stopped', primaryIp: null, agentReady: true,
    });

    const released = createAliyunEcsProvider(config, makeFetch({
      DescribeInstances: { data: { Instances: { Instance: [] } } },
    }, []));
    expect(await released.inspect('i-gone')).toEqual({
      powerState: 'unknown', primaryIp: null, agentReady: false,
    });
  });

  it('allocatePublicIp=true 时 primaryIp 优先公网地址；false 时即使有公网地址也回私网', async () => {
    const instance = {
      Status: 'Running',
      VpcAttributes: { PrivateIpAddress: { IpAddress: ['172.25.3.11'] } },
      PublicIpAddress: { IpAddress: ['47.100.1.2'] },
    };

    const publicMode = createAliyunEcsProvider(
      { ...config, allocatePublicIp: true },
      makeFetch({ DescribeInstances: { data: { Instances: { Instance: [instance] } } } }, []),
    );
    expect((await publicMode.inspect('i-1')).primaryIp).toBe('47.100.1.2');

    const privateMode = createAliyunEcsProvider(
      config,
      makeFetch({ DescribeInstances: { data: { Instances: { Instance: [instance] } } } }, []),
    );
    expect((await privateMode.inspect('i-1')).primaryIp).toBe('172.25.3.11');

    // 公网模式下实例还没拿到公网地址时回落私网，不返回 null 卡住探活
    const pending = createAliyunEcsProvider(
      { ...config, allocatePublicIp: true },
      makeFetch({
        DescribeInstances: {
          data: { Instances: { Instance: [{ Status: 'Running', VpcAttributes: { PrivateIpAddress: { IpAddress: ['172.25.3.12'] } } }] } },
        },
      }, []),
    );
    expect((await pending.inspect('i-2')).primaryIp).toBe('172.25.3.12');
  });
});

describe('snapshot / validateTemplate / capacity', () => {
  it('snapshot：查系统盘 → CreateSnapshot，返回 snapshotId', async () => {
    const calls: Recorded[] = [];
    const provider = createAliyunEcsProvider(config, makeFetch({
      DescribeDisks: { data: { Disks: { Disk: [{ DiskId: 'd-sys1', Type: 'system' }] } } },
      CreateSnapshot: { data: { SnapshotId: 's-1' } },
    }, calls));

    expect(await provider.snapshot('i-1', 'recycle-i-1')).toBe('s-1');
    expect(paramsOf(calls[0]!).get('DiskType')).toBe('system');
    expect(paramsOf(calls[1]!).get('DiskId')).toBe('d-sys1');
  });

  it('validateTemplate：镜像 Available 才算通过', async () => {
    const ok = createAliyunEcsProvider(config, makeFetch({
      DescribeImages: { data: { Images: { Image: [{ ImageId: 'm-win2022-stats', Status: 'Available' }] } } },
    }, []));
    const building = createAliyunEcsProvider(config, makeFetch({
      DescribeImages: { data: { Images: { Image: [{ ImageId: 'm-win2022-stats', Status: 'Creating' }] } } },
    }, []));
    const missing = createAliyunEcsProvider(config, makeFetch({
      DescribeImages: { data: { Images: { Image: [] } } },
    }, []));

    expect(await ok.validateTemplate(template)).toBe(true);
    expect(await building.validateTemplate(template)).toBe(false);
    expect(await missing.validateTemplate(template)).toBe(false);
  });

  it('capacity 恒 0（ECS 无宿主池，DMS 以 IPAM/配额为准）', async () => {
    const provider = createAliyunEcsProvider(config, makeFetch({}, []));
    expect(await provider.capacity()).toEqual({ cpuUsage: 0, memUsage: 0, diskUsage: 0, freeIpCount: 0 });
  });
});

describe('ACS3 签名与错误处理', () => {
  it('每个请求都带 ACS3 签名头，SignedHeaders 覆盖 x-acs-* 与 host', async () => {
    const calls: Recorded[] = [];
    const provider = createAliyunEcsProvider(config, makeFetch({ StartInstance: { data: {} } }, calls));

    await provider.start('i-1');
    const auth = calls[0]!.authorization;
    expect(auth.startsWith('ACS3-HMAC-SHA256 Credential=LTAI-test-key, ')).toBe(true);
    expect(auth).toContain('SignedHeaders=host;x-acs-action;x-acs-date;x-acs-signature-nonce;x-acs-version,');
    expect(auth).toContain('Signature=');
    expect(new URL(calls[0]!.url).searchParams.get('Version') ?? '').toBe('');
    // 版本走 x-acs-version 头而不是 query 参数
    expect(new URL(calls[0]!.url).host).toBe('ecs.cn-hangzhou.aliyuncs.com');
  });

  it('非 2xx 抛 AliyunEcsError，带 Action 与 Message', async () => {
    const provider = createAliyunEcsProvider(config, makeFetch({
      StartInstance: {
        status: 403,
        raw: JSON.stringify({ RequestId: 'r-9', Message: 'Forbidden.RAM', Code: 'Forbidden.RAM' }),
      },
    }, []));

    const error = await provider.start('i-1').catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AliyunEcsError);
    expect((error as AliyunEcsError).action).toBe('StartInstance');
    expect((error as AliyunEcsError).requestId).toBe('r-9');
    expect((error as AliyunEcsError).detail).toContain('Forbidden.RAM');
  });

  it('shutdown 等不到 Stopped 时超时抛错（调用方降级硬停）', async () => {
    // 本文件不碰数据库，可安全用假时钟推进轮询（真实 3s 间隔会把测试拖慢）
    vi.useFakeTimers();
    try {
      const provider = createAliyunEcsProvider(config, makeFetch({
        StopInstance: { data: {} },
        DescribeInstances: { data: { Instances: { Instance: [{ Status: 'Stopping' }] } } },
      }, []));

      const pending = provider.shutdown('i-1', 50_000);
      const assertion = expect(pending).rejects.toThrow(AliyunEcsError);
      await vi.advanceTimersByTimeAsync(120_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
