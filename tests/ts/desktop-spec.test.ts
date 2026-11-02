/**
 * resolveVmSpec / toSpecUpdate —— 方案 7.6（v2.1 A12）规格决策单元测试
 *
 * 规则：spec = quota.default_* ?? template.*，且 default 不得超过 max（fail-fast）。
 * 磁盘不进这套逻辑（模板下限，A14）。
 */
import { describe, expect, it } from 'vitest';
import { resolveVmSpec, toSpecUpdate, type SpecSource } from '../../src/desktop/provider/types.js';

const baseTemplate = { vcpu: 4, memoryMb: 8192 } as const;

const makeSource = (quota: SpecSource['quota']): SpecSource => ({ template: baseTemplate, quota });

describe('resolveVmSpec', () => {
  it('无配额：取模板基线', () => {
    const spec = resolveVmSpec(makeSource(null), 'DESK-alice');
    expect(spec).toMatchObject({ name: 'DESK-alice', vcpu: 4, memoryMb: 8192, staticIp: undefined });
  });

  it('配额 default 为 null：回落模板基线', () => {
    const quota = { defaultVcpu: null, defaultMemoryMb: null, maxVcpu: 8, maxMemoryMb: 16384 };
    const spec = resolveVmSpec(makeSource(quota), 'DESK-alice');
    expect(spec).toMatchObject({ vcpu: 4, memoryMb: 8192 });
  });

  it('配额 default 覆盖模板基线（分档核心路径）', () => {
    const quota = { defaultVcpu: 8, defaultMemoryMb: 16384, maxVcpu: 8, maxMemoryMb: 16384 };
    const spec = resolveVmSpec(makeSource(quota), 'DESK-alice', '10.20.3.11');
    expect(spec).toMatchObject({ vcpu: 8, memoryMb: 16384, staticIp: '10.20.3.11' });
  });

  it('default 超过 max：fail-fast 抛错（配额表配错必须阻断，不能静默放大）', () => {
    const quota = { defaultVcpu: 16, defaultMemoryMb: 16384, maxVcpu: 8, maxMemoryMb: 16384 };
    expect(() => resolveVmSpec(makeSource(quota), 'DESK-alice')).toThrow(/exceeds quota max/);
  });

  it('default 部分覆盖：只给内存档位时 vcpu 回落基线', () => {
    const quota = { defaultVcpu: null, defaultMemoryMb: 16384, maxVcpu: 8, maxMemoryMb: 16384 };
    const spec = resolveVmSpec(makeSource(quota), 'DESK-alice');
    expect(spec).toMatchObject({ vcpu: 4, memoryMb: 16384 });
  });
});

describe('toSpecUpdate（rebuild 重算）', () => {
  it('按当前配额档位重算，不沿用旧 spec', () => {
    const quota = { defaultVcpu: 2, defaultMemoryMb: 4096, maxVcpu: 8, maxMemoryMb: 16384 };
    const update = toSpecUpdate(makeSource(quota));
    expect(update).toEqual({ specVcpu: 2, specMemoryMb: 4096 });
  });

  it('无配额：回落模板基线', () => {
    const update = toSpecUpdate(makeSource(null));
    expect(update).toEqual({ specVcpu: 4, specMemoryMb: 8192 });
  });
});
