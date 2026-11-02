/**
 * Provider 抽象接口 —— docs/multi-vm-desktop-plan.md 6.3
 *
 * 这是 DMS 与虚拟化平台（Proxmox / ECS / …）之间唯一的边界。实现方只允许
 * 通过本接口操作 VM，禁止绕过它直接调 Provider REST —— 否则灰度期切平台
 * （Proxmox → ECS）时要改业务代码。
 *
 * ⚠️ Proxmox 实现要点（方案 6.3 实测结论，写代码前必读）：
 *  - clone API **没有** cores/memory 参数：必须在 clone 之后、start 之前用
 *    `PUT /nodes/{node}/qemu/{vmid}/config` 写入规格。新克隆的 VM 尚未启动过，
 *    `clone → config → start` 与「创建时指定规格」完全等价（A13）。
 *  - 运行中的 VM **不做热调整**（Windows 内存热加基本不可用；A14），
 *    变更规格一律走 rebuild。
 *  - clone 返回的是 vmid（如 '9101'），start/config/power 操作全部以它为 ref。
 */
import type { DesktopProviderKind, DesktopTemplate } from '../../db/schema.js';

/** 克隆请求规格：spec 取 desk_instances.spec_*（= quota.default_* ?? template.*，方案 7.6） */
export interface VmSpec {
  /** 'DESK-alice'（计算机名，注入 guest 由 DMS 负责，Provider 只当 VM name） */
  readonly name: string;
  /** 分配规格；Provider 实现必须写进 VM config（clone 后 config，见文件头） */
  readonly vcpu: number;
  readonly memoryMb: number;
  /** 推荐：静态 IP，开机即可连，不必等 Guest Agent 回读 */
  readonly staticIp?: string;
  readonly gateway?: string;
  /** Proxmox 存储名 / ECS 磁盘类别，null = 模板默认 */
  readonly storage?: string;
  /** 目标宿主节点（null = Provider 自行调度） */
  readonly targetNode?: string;
}

/** 宿主池水位（DMS 侧做 >85% 拒绝分配 + P0 告警，方案 5.4 / 9.8） */
export interface Capacity {
  /** 0~1 */
  readonly cpuUsage: number;
  /** 0~1 */
  readonly memUsage: number;
  /** 0~1 */
  readonly diskUsage: number;
  /** 可用 IP 数（IPAM 视角） */
  readonly freeIpCount: number;
}

/** Provider 侧 VM 定位符与探活结果 */
export interface VmRef {
  /** Proxmox vmid（'9101'）/ ECS instanceId */
  readonly provider: DesktopProviderKind;
  readonly ref: string;
  readonly node?: string;
}

/** 电源动作；reset = 硬重置（蓝屏自愈用，方案 9.10） */
export type PowerAction = 'start' | 'stop' | 'suspend' | 'reset';

export interface DesktopProvider {
  readonly kind: DesktopProviderKind;

  /** 启动期健康检查：token 有效、模板可达（失败要阻断 DMS worker 启动） */
  validateTemplate(template: DesktopTemplate): Promise<boolean>;

  /**
   * 克隆模板并落规格。返回 provider_ref。
   * 契约：本方法返回时 VM 必须已带上 spec 的 cores/memory（Proxmox = clone 后 config），
   * 但**不要求已开机** —— start 由调用方在 Guest 账号注入之后决定。
   */
  clone(template: DesktopTemplate, spec: VmSpec): Promise<string>;

  start(ref: string): Promise<void>;
  power(ref: string, action: PowerAction): Promise<void>;

  /** 优雅关机失败时由调用方降级为 power(ref,'stop') */
  shutdown(ref: string, timeoutMs: number): Promise<void>;

  destroy(ref: string): Promise<void>;

  /** 读取实际状态（IP、power_state、agent_ready）—— reconcile 对账与自愈的数据源 */
  inspect(ref: string): Promise<{
    readonly powerState: 'running' | 'stopped' | 'suspended' | 'unknown';
    readonly primaryIp: string | null;
    readonly agentReady: boolean;
  }>;

  /** 回收前快照（失败销毁路径的恢复点，方案 9.10） */
  snapshot(ref: string, name: string): Promise<string>;

  /** 宿主池水位（分配前置校验用） */
  capacity(node?: string): Promise<Capacity>;
}

/**
 * 规格决策（方案 7.6，v2.1 A12）—— 配额覆盖模板基线。
 * 放在 provider/ 而非 quota 服务里，因为它产出的是 VmSpec 的 vcpu/memoryMb 输入。
 */
export interface SpecSource {
  readonly template: Pick<DesktopTemplate, 'vcpu' | 'memoryMb'>;
  readonly quota: {
    readonly defaultVcpu: number | null;
    readonly defaultMemoryMb: number | null;
    readonly maxVcpu: number;
    readonly maxMemoryMb: number;
  } | null;
}

export const resolveVmSpec = (
  source: SpecSource,
  name: string,
  staticIp?: string,
): VmSpec => {
  const vcpu = source.quota?.defaultVcpu ?? source.template.vcpu;
  const memoryMb = source.quota?.defaultMemoryMb ?? source.template.memoryMb;
  // fail-fast：配额表 default_* 配错（超过自己的 max_*）时阻断创建而不是静默放大
  if (source.quota !== null) {
    if (vcpu > source.quota.maxVcpu || memoryMb > source.quota.maxMemoryMb) {
      throw new Error(
        `quota default exceeds quota max: vcpu=${vcpu}/${source.quota.maxVcpu}, `
        + `memoryMb=${memoryMb}/${source.quota.maxMemoryMb}`,
      );
    }
  }
  return { name, vcpu, memoryMb, staticIp };
};

/** rebuild 时重算分配规格并写回 desk_instances（A12：按**当前**配额档位重算，不是沿用旧值） */
export interface SpecUpdate {
  readonly specVcpu: number;
  readonly specMemoryMb: number;
}

export const toSpecUpdate = (source: SpecSource): SpecUpdate => {
  const spec = resolveVmSpec(source, 'ignored');
  return { specVcpu: spec.vcpu, specMemoryMb: spec.memoryMb };
};
