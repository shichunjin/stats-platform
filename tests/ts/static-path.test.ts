/**
 * 静态资源根目录解析 —— 回归防护
 *
 * 曾把 REPO_ROOT 写死成 `new URL('..', import.meta.url)`，只在开发态（`tsx src/index.ts`）
 * 正确；构建态（`node dist/src/server.js`）会算成 `<root>/dist`，进而去读
 * `dist/legacy-static/login.html`，导致 /login 全量 500。
 */
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { findRepoRoot } from '../../src/server.js';

const made: string[] = [];

/** 造一个假仓库根：只有根目录有 package.json */
const makeFakeRepo = (): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stats-platform-repo-')));
  writeFileSync(join(root, 'package.json'), '{"name":"stats-platform"}');
  made.push(root);
  return root;
};

afterAll(() => {
  // 只删自己造的空 package.json，目录树交给系统临时目录回收
  for (const root of made) {
    writeFileSync(join(root, 'package.json'), '');
  }
});

describe('findRepoRoot', () => {
  it('开发态布局：src/ 上一级就是仓库根', () => {
    const root = makeFakeRepo();
    mkdirSync(join(root, 'src'), { recursive: true });
    expect(findRepoRoot(join(root, 'src'))).toBe(root);
  });

  it('构建态布局：dist/src/ 要上两级，不能停在 dist', () => {
    const root = makeFakeRepo();
    mkdirSync(join(root, 'dist', 'src'), { recursive: true });
    // dist 下再放一个 package.json 才可能让「停在 dist」的写法通过，这里故意不放
    expect(findRepoRoot(join(root, 'dist', 'src'))).toBe(root);
  });

  it('找不到 package.json 时不死循环，退回起始目录', () => {
    const root = makeFakeRepo();
    const deep = join(root, 'a', 'b', 'c', 'd', 'e', 'f', 'g');
    mkdirSync(deep, { recursive: true });
    expect(findRepoRoot(deep)).toBe(deep);
  });
});
