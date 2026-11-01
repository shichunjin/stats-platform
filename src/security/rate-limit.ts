/**
 * 滑动窗口限流 —— app/rate_limit.py
 *
 * 修掉两个既有缺陷：
 *  - SEC-16：原实现只对「当前 key」清理，未活跃 key 永不回收且无 key 上限
 *            → 配合可伪造的 XFF 能灌爆内存打挂单 worker。
 *            这里加全局周期清扫 + maxKeys 上限 + 淘汰策略。
 *  - SEC-04：原实现无条件信任 X-Forwarded-For 首段 → 限流可绕过、审计 IP 可被污染。
 *
 * 并发说明：Python 版用 threading.Lock；Node 单线程事件循环下，只要 check() 内部
 * 没有 await，天然就是原子的 —— 所以这个方法是**同步**的，不要改成 async。
 */
import type { FastifyRequest } from 'fastify';
import { getSettings } from '../config/env.js';

interface HitRecord {
  timestamps: number[];
  updatedAt: number;
}

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
}

export interface RateLimiterOptions {
  readonly maxKeys: number;
  readonly sweepIntervalMs: number;
  readonly now?: () => number;
}

const DEFAULT_OPTIONS: RateLimiterOptions = {
  maxKeys: 10_000,
  sweepIntervalMs: 60_000,
};

/** junk 一律收敛成单一 key，防止用随机值灌爆 key 空间 */
const IP_PATTERN = /^[0-9a-fA-F.:]{2,45}$/;

export class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, HitRecord>();

  private readonly now: () => number;

  private readonly maxKeys: number;

  private readonly sweepTimer: NodeJS.Timeout | null;

  constructor(options: Partial<RateLimiterOptions> = {}) {
    const merged = { ...DEFAULT_OPTIONS, ...options };
    this.now = merged.now ?? (() => performance.now());
    this.maxKeys = merged.maxKeys;

    // unref：定时器不阻止进程退出（测试里尤为重要）
    this.sweepTimer = setInterval(() => this.sweep(), merged.sweepIntervalMs);
    this.sweepTimer.unref();
  }

  check(key: string, maxAttempts: number, windowSeconds: number): RateLimitResult {
    const now = this.now();
    const windowMs = windowSeconds * 1_000;
    const cutoff = now - windowMs;

    let record = this.hits.get(key);
    if (!record) {
      record = { timestamps: [], updatedAt: now };
      this.hits.set(key, record);
      this.evictIfNeeded();
    }

    record.timestamps = record.timestamps.filter((timestamp) => timestamp > cutoff);

    if (record.timestamps.length < maxAttempts) {
      record.timestamps.push(now);
      record.updatedAt = now;
      return { allowed: true, retryAfterSeconds: 0 };
    }

    const oldest = record.timestamps[0] ?? now;
    const wait = Math.ceil((windowMs - (now - oldest)) / 1_000);
    return { allowed: false, retryAfterSeconds: Math.max(wait, 1) };
  }

  private sweep(): void {
    const now = this.now();
    // 不同 key 可能配了不同窗口，取保守上界（1 小时）避免误删
    const cutoff = now - 3_600_000;
    for (const [key, record] of this.hits) {
      record.timestamps = record.timestamps.filter((timestamp) => timestamp > cutoff);
      if (record.timestamps.length === 0) this.hits.delete(key);
    }
  }

  private evictIfNeeded(): void {
    if (this.hits.size <= this.maxKeys) return;

    for (const [key, record] of this.hits) {
      if (record.timestamps.length === 0) this.hits.delete(key);
    }
    if (this.hits.size <= this.maxKeys) return;

    const stale = [...this.hits.entries()]
      .sort((a, b) => a[1].updatedAt - b[1].updatedAt)
      .slice(0, Math.max(1, this.hits.size - this.maxKeys));

    for (const [key] of stale) this.hits.delete(key);

    console.warn('[rate-limit] key 数量超上限，已淘汰最久未使用记录', {
      size: this.hits.size,
      maxKeys: this.maxKeys,
    });
  }

  reset(): void {
    this.hits.clear();
  }

  dispose(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }
}

export const limiter = new SlidingWindowRateLimiter();

export const getClientIp = (request: FastifyRequest): string => {
  const { trustProxy } = getSettings();

  if (trustProxy) {
    const forwarded = request.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
      // X-Forwarded-For: client, proxy1, proxy2 —— 取第一个（真实客户端）
      const candidate = forwarded.split(',')[0]?.trim() ?? '';
      if (IP_PATTERN.test(candidate)) return candidate;
    }
  }

  const direct = request.ip ?? 'unknown';
  return IP_PATTERN.test(direct) ? direct : 'unknown';
};

const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_SECONDS = 60;
const REGISTER_MAX_ATTEMPTS = 3;
const REGISTER_WINDOW_SECONDS = 300;

export interface RateLimitVerdict {
  readonly blocked: boolean;
  readonly message?: string;
  readonly retryAfterSeconds?: number;
}

/** 认证接口限流判定；由路由层决定如何回 429 */
export const checkAuthRateLimit = (request: FastifyRequest): RateLimitVerdict => {
  if (!getSettings().rateLimitEnabled) return { blocked: false };

  const ip = getClientIp(request);
  const path = request.routeOptions?.url ?? request.url;

  if (path.endsWith('/auth/register')) {
    const result = limiter.check(`reg:${ip}`, REGISTER_MAX_ATTEMPTS, REGISTER_WINDOW_SECONDS);
    return result.allowed
      ? { blocked: false }
      : {
        blocked: true,
        message: `注册请求过于频繁，请 ${result.retryAfterSeconds} 秒后重试`,
        retryAfterSeconds: result.retryAfterSeconds,
      };
  }

  if (path.endsWith('/auth/login')) {
    const result = limiter.check(`login:${ip}`, LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_SECONDS);
    return result.allowed
      ? { blocked: false }
      : {
        blocked: true,
        message: `登录尝试过于频繁，请 ${result.retryAfterSeconds} 秒后重试`,
        retryAfterSeconds: result.retryAfterSeconds,
      };
  }

  return { blocked: false };
};
