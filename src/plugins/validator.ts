/**
 * zod -> JSON Schema，交给 Fastify 做运行时校验，同时供 @fastify/swagger 出文档。
 * 一个 schema 同时管住「编译期类型 / 运行时校验 / OpenAPI 描述」三件事。
 */
import type { FastifySchema } from 'fastify';
import type { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

export interface RouteSchemas {
  readonly body?: z.ZodType;
  readonly params?: z.ZodType;
  readonly querystring?: z.ZodType;
  readonly response?: Readonly<Record<number, z.ZodType>>;
}

const convert = (schema: z.ZodType): unknown =>
  zodToJsonSchema(schema, { target: 'jsonSchema7' });

/**
 * ⚠️ 只输出「真正给了 schema」的那几个键。
 *
 * 若把 `body: undefined` 之类塞进 Fastify 的 route schema，Fastify 会认为
 * 「声明了 body 校验但内容为空」，于是刷一屏 FSTWRN001 警告，
 * 并且 GET 路由会莫名开始校验 body。
 */
export const asRouteSchema = (schemas: RouteSchemas): FastifySchema => {
  const result: Record<string, unknown> = {};

  for (const key of ['body', 'params', 'querystring'] as const) {
    const schema = schemas[key];
    if (schema !== undefined) result[key] = convert(schema);
  }

  if (schemas.response !== undefined) {
    result.response = Object.fromEntries(
      Object.entries(schemas.response).map(([code, schema]) => [code, convert(schema)]),
    );
  }

  return result as FastifySchema;
};
