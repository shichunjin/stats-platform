import { z } from 'zod';

/**
 * 筛选条件类型 —— 独立成模块，供 db/schema.ts 以 type-only 引用（避免循环依赖）
 *
 * Python 侧是裸 `dict`，任意结构都能写库；这里给出精确形状 + 运行时校验。
 */

/** 值 / [min, max] 区间 / 模糊文本 */
const rangeTupleSchema = z.tuple([z.number().finite().nullable(), z.number().finite().nullable()]);

/**
 * ⚠️ Node 特有风险：Python 的 dict 里 "__proto__" 只是普通键；
 * 在 JS 里 obj["__proto__"] = {...} 会改原型链（原型污染）。
 * 外部可控的 JSON 键名必须显式拒绝。
 */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** 单请求允许的筛选列上限，防超大 JSON 打爆解析与 SQL */
const MAX_FILTER_KEYS = 50;

export const filterValueSchema = z.union([
  z.string().max(256),
  z.number().finite(),
  z.null(),
  rangeTupleSchema,
]);

export const filterMapSchema = z
  .record(z.string().min(1).max(128), filterValueSchema)
  .superRefine((value, ctx) => {
    const keys = Object.keys(value);
    if (keys.length > MAX_FILTER_KEYS) {
      // zod 的 too_big 只支持 array/string/number/date/set/bigint，record 没有对应
      // 类型标记，用 custom 承载（语义等价，错误路径仍在根上）
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `筛选条件最多 ${MAX_FILTER_KEYS} 项，当前 ${keys.length} 项`,
      });
    }
    for (const key of keys) {
      if (FORBIDDEN_KEYS.has(key)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: '非法筛选列名' });
      }
    }
  });

/**
 * 出向（响应）用的 filters schema：刻意放宽为「任意 JSON 对象」。
 *
 * 背景：Python 侧 filters 是裸 `dict`，存量库里可能存在布尔、任意长度数组、嵌套对象等
 * **入向校验不接受**的值。而 Fastify 的序列化器遇到不匹配 schema 的值是**运行时抛 TypeError**
 * （不是忽略字段），结果是整个端点 500（线上真实出现过：GET /user/data-applies）。
 *
 * 因此出向 schema 绝不能比库里的存量数据更严：入向严格校验，出向原样透传。
 */
export const filterMapOutSchema = z.record(z.string(), z.unknown());

export type FilterValue = z.infer<typeof filterValueSchema>;
export type FilterMap = z.infer<typeof filterMapSchema>;
