/**
 * 默认任务处理器表 —— worker 的分发表
 *
 * 只注册「已实现」的类型：未注册的类型会被 worker 判失败并留下
 * `type=... 未注册` 的错误码，而不是静默卡住 —— 这样漏实现会立刻暴露。
 *
 * 目前尚未实现（会以「未注册」失败，属预期）：`config` / `register` / `rebuild`。
 * 它们对应模板制作与规格变更（阶段 3 与后续），先不占位空实现 ——
 * 空实现会让任务「成功但什么也没做」，比失败更难排查。
 */
import type { HandlerMap } from '../worker.js';
import { createCreateHandler } from './create.js';
import { createProbeHandler } from './probe.js';
import { createRecycleHandler } from './recycle.js';
import { createStartHandler } from './start.js';
import { createSuspendHandler } from './suspend.js';

export const defaultHandlers = (): HandlerMap => ({
  create: createCreateHandler(),
  start: createStartHandler(),
  probe: createProbeHandler(),
  suspend: createSuspendHandler(),
  recycle: createRecycleHandler(),
});
