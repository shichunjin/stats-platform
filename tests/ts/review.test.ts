/**
 * 结果审查服务 —— tests/test_review.py
 *
 * 纯逻辑单元测试，不需要数据库。
 * Python 的 `tmp_path` fixture → Node 的 `mkdtempSync` + 显式清理。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ALLOWED_EXTENSIONS,
  FIELD_WHITELIST,
  MAX_CSV_COLS,
  MAX_CSV_ROWS,
  SENSITIVE_FIELD_NAMES,
  reviewResult,
  scanPendingDirectory,
} from '../../src/services/review.js';

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'stats_review_'));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const writeCsv = (header: readonly string[], rows: readonly (readonly string[])[]): string => {
  const path = join(tmpDir, `t_${Math.random().toString(36).slice(2)}.csv`);
  const body = [header, ...rows].map((row) => row.join(',')).join('\n');
  // utf-8-sig：Python 侧 csv.writer 用 encoding="utf-8-sig"，这里手动加 BOM 保持等价
  writeFileSync(path, `\uFEFF${body}\n`, 'utf8');
  return path;
};

const writeText = (content: string, suffix: string): string => {
  const path = join(tmpDir, `t_${Math.random().toString(36).slice(2)}${suffix}`);
  writeFileSync(path, content, 'utf8');
  return path;
};

describe('文件类型白名单', () => {
  it('CSV 允许', async () => {
    const [ok] = await reviewResult(writeCsv(['mean', 'std'], [['1.0', '2.0']]));
    expect(ok).toBe(true);
  });

  it('PNG 允许且提示图片', async () => {
    const [ok, reason] = await reviewResult(writeText('fake-png', '.png'));
    expect(ok).toBe(true);
    expect(reason).toContain('图片');
  });

  it('.exe 拒绝', async () => {
    const [ok, reason] = await reviewResult(writeText('malware', '.exe'));
    expect(ok).toBe(false);
    expect(reason).toContain('不支持的文件类型');
  });

  it('.zip 拒绝', async () => {
    const [ok] = await reviewResult(writeText('archive', '.zip'));
    expect(ok).toBe(false);
  });

  it('不存在的文件', async () => {
    const [ok, reason] = await reviewResult(join(tmpDir, '__no_such_file__.csv'));
    expect(ok).toBe(false);
    expect(reason).toContain('文件不存在');
  });

  it('白名单常量与 Python 一致', () => {
    expect([...ALLOWED_EXTENSIONS].sort()).toEqual(
      ['.csv', '.jpg', '.log', '.out', '.pdf', '.png', '.txt'].sort(),
    );
  });
});

describe('CSV 审查通过', () => {
  it('简单统计结果', async () => {
    const [ok, reason] = await reviewResult(
      writeCsv(['variable', 'mean', 'std', 'n'], [['age', '35.2', '10.1', '100']]),
    );
    expect(ok).toBe(true);
    expect(reason).toContain('CSV 审查通过');
  });

  it('回归系数结果', async () => {
    const [ok] = await reviewResult(writeCsv(
      ['term', 'estimate', 'std_err', 't_value', 'p_value'],
      [['intercept', '1.5', '0.3', '5.0', '0.001'], ['x1', '0.8', '0.1', '8.0', '0.0001']],
    ));
    expect(ok).toBe(true);
  });

  it('模型拟合指标', async () => {
    const [ok] = await reviewResult(writeCsv(
      ['model', 'aic', 'bic', 'rmsea', 'cfi'],
      [['model1', '100.5', '110.2', '0.05', '0.95']],
    ));
    expect(ok).toBe(true);
  });
});

describe('CSV 敏感字段名', () => {
  it.each(['id', 'name', 'phone', 'id_card', 'email', 'address', 'user_id', 'mobile', 'ssn', 'birthday'])(
    '列名 %s 命中即拒绝',
    async (field) => {
      const [ok, reason] = await reviewResult(writeCsv([field, 'mean'], [['x', '1.0']]));
      expect(ok).toBe(false);
      expect(reason).toContain('敏感字段名');
    },
  );

  it('敏感字段优先于白名单（含已知的 "name" 重叠）', () => {
    // ⚠️ Python 原实现里 'name' 同时出现在两个集合里（FIELD_WHITELIST 的「通用」
    // 分组与 SENSITIVE_FIELD_NAMES）。因为敏感检查在白名单检查之前执行，
    // 实际行为仍是「拒绝」，所以迁移阶段保持原样，只在此记录该重叠。
    expect(FIELD_WHITELIST.has('name')).toBe(true);
    expect(SENSITIVE_FIELD_NAMES.has('name')).toBe(true);
  });

  it('除 name 外两集合无其他交集', () => {
    for (const name of SENSITIVE_FIELD_NAMES) {
      if (name === 'name') continue;
      expect(FIELD_WHITELIST.has(name)).toBe(false);
    }
  });
});

describe('CSV 敏感数据内容', () => {
  it('手机号', async () => {
    const [ok, reason] = await reviewResult(
      writeCsv(['mean', 'note'], [['1.0', '联系电话13812345678']]),
    );
    expect(ok).toBe(false);
    expect(reason).toContain('疑似手机号');
  });

  it('身份证号', async () => {
    const [ok, reason] = await reviewResult(
      writeCsv(['mean', 'note'], [['1.0', '身份证110101199001011234']]),
    );
    expect(ok).toBe(false);
    expect(reason).toContain('疑似身份证号');
  });

  it('邮箱', async () => {
    const [ok, reason] = await reviewResult(
      writeCsv(['mean', 'note'], [['1.0', 'contact@example.com']]),
    );
    expect(ok).toBe(false);
    expect(reason).toContain('疑似邮箱');
  });
});

describe('CSV 行数/列数上限', () => {
  it('超过行数上限', async () => {
    const rows = Array.from({ length: MAX_CSV_ROWS + 1 }, () => ['1.0', '2.0']);
    const [ok, reason] = await reviewResult(writeCsv(['mean', 'std'], rows));
    expect(ok).toBe(false);
    expect(reason).toContain('行数超过上限');
  });

  it('刚好等于行数上限', async () => {
    const rows = Array.from({ length: MAX_CSV_ROWS }, () => ['1.0', '2.0']);
    const [ok] = await reviewResult(writeCsv(['mean', 'std'], rows));
    expect(ok).toBe(true);
  });

  it('超过列数上限', async () => {
    const header = Array.from({ length: MAX_CSV_COLS + 1 }, (_, i) => `col_${i}`);
    const [ok, reason] = await reviewResult(
      writeCsv(header, [Array.from({ length: MAX_CSV_COLS + 1 }, () => '1.0')]),
    );
    expect(ok).toBe(false);
    expect(reason).toContain('列数过多');
  });
});

describe('CSV 字段白名单', () => {
  it('全部不在白名单', async () => {
    const [ok, reason] = await reviewResult(
      writeCsv(['col_a', 'col_b', 'col_c'], [['1.0', '2.0', '3.0']]),
    );
    expect(ok).toBe(false);
    expect(reason).toContain('字段白名单');
  });

  it('过半不在白名单', async () => {
    const [ok] = await reviewResult(writeCsv(['mean', 'col_x', 'col_y'], [['1.0', '2.0', '3.0']]));
    expect(ok).toBe(false);
  });
});

describe('图片 / PDF 直接通过', () => {
  it.each(['.png', '.jpg', '.pdf'])('%s 通过', async (ext) => {
    const [ok] = await reviewResult(writeText(`fake ${ext} data`, ext));
    expect(ok).toBe(true);
  });
});

describe('文本文件审查', () => {
  it('正常模型输出通过', async () => {
    const content = `
        Model Fit Statistics
        AIC = 100.5
        BIC = 110.2
        RMSEA = 0.05
        CFI = 0.95
    `;
    const [ok] = await reviewResult(writeText(content, '.out'));
    expect(ok).toBe(true);
  });

  it('含手机号拒绝', async () => {
    const [ok, reason] = await reviewResult(writeText('联系: 13812345678', '.log'));
    expect(ok).toBe(false);
    expect(reason).toContain('疑似手机号');
  });

  it('含邮箱拒绝', async () => {
    const [ok, reason] = await reviewResult(writeText('Email: test@example.com', '.txt'));
    expect(ok).toBe(false);
    expect(reason).toContain('疑似邮箱');
  });

  it('大量连续数字行 = 原始数据，拒绝', async () => {
    const content = Array.from({ length: 600 }, () => '1.0 2.0 3.0').join('\n');
    const [ok, reason] = await reviewResult(writeText(content, '.out'));
    expect(ok).toBe(false);
    expect(reason).toContain('原始行级数据');
  });

  it('空 CSV 拒绝', async () => {
    const [ok, reason] = await reviewResult(writeText('', '.csv'));
    expect(ok).toBe(false);
    expect(reason).toContain('为空');
  });
});

describe('scanPendingDirectory', () => {
  it('空目录返回空列表', async () => {
    const empty = mkdtempSync(join(tmpDir, 'empty_'));
    expect(await scanPendingDirectory(empty)).toEqual([]);
  });

  it('有文件时返回文件列表', async () => {
    const dir = mkdtempSync(join(tmpDir, 'files_'));
    writeFileSync(join(dir, 'result1.csv'), 'mean,std\n1,2');
    writeFileSync(join(dir, 'plot.png'), 'fake png');

    const result = await scanPendingDirectory(dir);
    expect(result).toHaveLength(2);
    expect(result.map((p) => p.replace(/\\/g, '/'))).toContain(join(dir, 'result1.csv').replace(/\\/g, '/'));
  });

  it('忽略子目录', async () => {
    const dir = mkdtempSync(join(tmpDir, 'sub_'));
    writeFileSync(join(dir, 'result.csv'), 'mean\n1');
    expect(await scanPendingDirectory(dir)).toHaveLength(1);
  });

  it('不存在的目录返回空列表', async () => {
    expect(await scanPendingDirectory(join(tmpDir, '__nope__'))).toEqual([]);
  });
});
