/**
 * 出向 schema 的序列化兼容性 —— 两个真实线上 500 的回归防护
 *
 * Fastify 用 fast-json-stringify 按 schema 序列化响应。它对「不匹配 schema 的值」
 * 是**运行时抛 TypeError**（不是跳过字段），所以响应 schema 只要比代码实际能产出
 * 的值更严，整个端点就是 500。这类 bug 在单元测试里看不见（测试数据都合规），
 * 只有存量脏数据或特定列类型才会触发，因此单独立一个文件锁住。
 */
import { describe, expect, it } from 'vitest';
import build from 'fast-json-stringify';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { dataApplyOutSchema, dataColumnOutSchema } from '../../src/schemas/index.js';

type Serializer = (value: unknown) => string;

/** 走与 Fastify 完全相同的序列化路径：zod → JSON Schema → fast-json-stringify */
const stringify = (schema: z.ZodType, value: unknown): string => {
  const serialize = build(
    zodToJsonSchema(schema, { target: 'jsonSchema7' }) as never,
  ) as Serializer;
  return serialize(value);
};

/** JSON.parse 返回 any，统一在这里收窄，避免 lint 的 no-unsafe-* 满屏 */
const parse = <T>(json: string): T => JSON.parse(json) as T;

describe('dataApplyOutSchema', () => {
  it('存量 filters 含布尔 / 任意长度数组 / 嵌套对象时仍能序列化', () => {
    // Python 侧 filters 是裸 dict，库里可能残留入向校验不接受的值
    const legacy = {
      id: 1,
      data_name: 'testData',
      purpose: 'p',
      fields: [],
      filters: { 性别: true, 部门: ['A组', 'B组'], 分数: [1, 2, 3], 备注: { a: 1 }, 空: null },
      time_range: null,
      priority: 'medium',
      status: 'pending',
      reject_reason: null,
      apply_time: '2026-01-01T00:00:00.000Z',
      finish_time: null,
      target_user_id: 1,
    };

    const json = stringify(z.array(dataApplyOutSchema), [legacy]);
    expect(parse<{ filters: Record<string, unknown> }[]>(json)[0]?.filters)
      .toEqual(legacy.filters);
  });

  it('规范 filters 也能原样输出（放宽没有破坏正常路径）', () => {
    const row = {
      id: 1,
      data_name: 'testData',
      purpose: 'p',
      fields: ['年龄'],
      filters: { 年龄: [18, 60], 部门: '研发部' },
      time_range: ['2026-01-01T00:00:00.000Z', null],
      priority: 'high',
      status: 'pending',
      reject_reason: null,
      apply_time: '2026-01-01T00:00:00.000Z',
      finish_time: null,
      target_user_id: 1,
    };

    const json = stringify(dataApplyOutSchema, row);
    expect(parse<{ filters: Record<string, unknown> }>(json).filters)
      .toEqual({ 年龄: [18, 60], 部门: '研发部' });
  });
});

describe('dataColumnOutSchema', () => {
  it('日期列（type=date / control=daterange / min-max 为日期字符串）能序列化', () => {
    // dataset.ts 对日期列产出这套值；早期 schema 把 type/control 写成了窄枚举，
    // min/max 写成了 number，结果「表里存在日期列」就会让 /data/columns 全量 500
    const dateColumn = {
      name: '出生日期',
      type: 'date',
      control: 'daterange',
      min: '1950-01-01',
      max: '2010-12-31',
    };

    const json = stringify(z.array(dataColumnOutSchema), [dateColumn]);
    expect(parse<unknown[]>(json)[0]).toEqual(dateColumn);
  });

  it('数值区间列与枚举列也能序列化', () => {
    const columns = [
      { name: '年龄', type: 'int', control: 'range', min: 18, max: 60 },
      { name: '部门', type: 'text', control: 'select', options: ['研发部', '市场部'] },
    ];

    const json = stringify(z.array(dataColumnOutSchema), columns);
    expect(parse<unknown[]>(json)).toEqual(columns);
  });
});
