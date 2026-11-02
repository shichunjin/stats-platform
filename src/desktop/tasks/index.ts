/**
 * 默认任务处理器表 —— worker 的分发表
 *
 * 只注册「已实现」的类型：未注册的类型会被 worker 判失败并留下
 * `type=... 未注册` 的错误码，而不是静默卡住 —— 这样漏实现会立刻暴露。
 */
import type { HandlerMap } from '../worker.js';
import { createCreateHandler } from './create.js';

export const defaultHandlers = (): HandlerMap => ({
  create: createCreateHandler(),
});
