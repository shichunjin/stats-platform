/**
 * 默认任务处理器表 —— worker 的分发表
 *
 * 只注册「已实现」的类型：未注册的类型会被 worker 判失败并留下
 * `type=... 未注册` 的错误码，而不是静默卡住 —— 这样漏实现会立刻暴露。
 *
 * 目前尚未实现（会以「未注册」失败，属预期）：`config` / `register`。
 * 它们分别对应「模板内配置下发」与「账号注册」，都要先定 Windows 侧的执行通道
 * （目前只有 SSH，用于建本地账号；配置下发还依赖模板脚本与 Guest Agent）。
 * 先不占位空实现 —— 空实现会让任务「成功但什么也没做」，比失败更难排查。
 */
import type { HandlerMap } from '../worker.js';
import { createCreateHandler } from './create.js';
import { createProbeHandler } from './probe.js';
import { createRebuildHandler } from './rebuild.js';
import { createRecycleHandler } from './recycle.js';
import { createStartHandler } from './start.js';
import { createSuspendHandler } from './suspend.js';

export const defaultHandlers = (): HandlerMap => ({
  create: createCreateHandler(),
  start: createStartHandler(),
  probe: createProbeHandler(),
  suspend: createSuspendHandler(),
  recycle: createRecycleHandler(),
  rebuild: createRebuildHandler(),
});
