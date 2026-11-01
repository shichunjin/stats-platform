/**
 * 导出审查规则测试：类型门禁 + 相似度比对 + 免审自动发布 —— tests/test_similarity_export.py
 *
 * 与 Python 的差异：
 *  1. `similarity_to_dataset(cand, baseline)` 的第二个参数是可选的基线路径；
 *     `decide_export_review` 从 settings 取基线。TS 侧签名一致，
 *     但改基线要用 `overrideSettings({ datasetCsvPath })`（对应 monkeypatch settings）。
 *  2. Python 用 `tmp_path`（每用例独立目录）；TS 用 `mkdtempSync` + 显式 rmSync。
 *  3. 基线缓存是模块级 Map：Python 侧 conftest 直接 `._baseline_cache.clear()`，
 *     TS 侧导出 `resetBaselineCache()` 做同一件事。
 *  4. API 段：`request-export` 现在必须带 `file_names`，其余断言完全对齐。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import iconv from 'iconv-lite';
import { getSettings, overrideSettings } from '../../src/config/env.js';
import {
  decideExportReview,
  extractComparableText,
  resetBaselineCache,
  similarityToDataset,
} from '../../src/services/review.js';
import { buildTestApp, request, seedUser } from './helpers.js';
import { resetDatabase } from './setup.js';

/** 待导出目录禁止真实 SFTP 回拉（同 conftest 的 _no_remote_pending_pull） */
vi.mock('../../src/integrations/transfer.js', () => ({
  TransferError: class TransferError extends Error {},
  decodeRemote: (data: Buffer): string => data.toString('utf8'),
  connectSsh: async (): Promise<never> => { throw new Error('tests must not open SSH'); },
  execCommand: async (): Promise<{ stdout: string; stderr: string; code: number }> =>
    ({ stdout: '', stderr: '', code: 0 }),
  withSftp: async (): Promise<never> => { throw new Error('tests must not open SFTP'); },
  ensureRemoteDir: async (): Promise<void> => undefined,
  runIcaclsLock: async (): Promise<void> => undefined,
  uploadFileToWindows: async (): Promise<string> => 'C:\\workspace\\x',
  listRemoteFiles: async (): Promise<readonly { filename: string; size: number }[]> => [],
  downloadFileFromWindows: async (): Promise<void> => undefined,
}));

/* ---------------- 基线夹具 ---------------- */

const BASELINE_HEADER = 'id,score_alpha,score_beta,score_gamma';

/** 每行用独特长小数，保证「全新内容」的 token 不会碰巧命中基线 */
const baselineRows = (n = 20): string[] =>
  Array.from({ length: n }, (_unused, i) => `100${i},1.${String(i).padStart(4, '0')}11,2.${String(i).padStart(4, '0')}22,3.${String(i).padStart(4, '0')}33`);

let tmpDir: string;

const writeText = (name: string, content: string, encoding: BufferEncoding = 'utf8'): string => {
  const path = join(tmpDir, name);
  writeFileSync(path, content, encoding);
  return path;
};

const writeBytes = (name: string, content: Buffer | Uint8Array): string => {
  const path = join(tmpDir, name);
  writeFileSync(path, content);
  return path;
};

/** 建立基线文件并把 settings 指向它（对应 baseline_file fixture） */
const useBaseline = (name = 'baseline.csv'): string => {
  const path = writeText(name, `${BASELINE_HEADER}\n${baselineRows().join('\n')}`);
  overrideSettings({ datasetCsvPath: path });
  resetBaselineCache();
  return path;
};

const ORIGINAL_DATASET_CSV_PATH = getSettings().datasetCsvPath;

beforeEach(() => {
  resetBaselineCache();
});

afterAll(() => {
  overrideSettings({ datasetCsvPath: ORIGINAL_DATASET_CSV_PATH });
});

/* ============================================================
 * 相似度函数单测
 * ============================================================ */

describe('相似度比对与导出门禁', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'stats_sim_'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('完全切片：高相似度 → 转人工审核', async () => {
    const baseline = useBaseline();
    const cand = writeText('slice.csv', `${BASELINE_HEADER}\n${baselineRows().slice(0, 8).join('\n')}`);

    const [score] = await similarityToDataset(cand, baseline);
    expect(score).not.toBeNull();
    expect(score!).toBeGreaterThanOrEqual(0.99);

    const [decision, reason, decisionScore] = await decideExportReview(cand);
    expect(decision).toBe('review');
    expect(decisionScore).toBe(score);
    expect(reason).toContain('60%');
  });

  it('全新分析结果：低相似度 → 免审自动通过', async () => {
    useBaseline();
    const cand = writeText('analysis.csv',
      'metric,value\nzzz_rmsea_coef,9.87654321\nyyy_cfi_index,8.76543210\nxxx_tucker_lewis,7.65432109\n');

    const [score] = await similarityToDataset(cand);
    expect(score).not.toBeNull();
    expect(score!).toBeLessThan(0.6);

    const [decision, reason] = await decideExportReview(cand);
    expect(decision).toBe('auto');
    expect(reason).toContain('免审核');
  });

  it('阈值边界：命中率 0.60 转审核，0.50 免审', async () => {
    useBaseline();
    const rows = baselineRows();
    const fresh = [
      '2001,9.11111111,8.22222222,7.33333333',
      '2002,9.44444444,8.55555555,7.66666666',
      '2003,9.77777777,8.88888888,7.99999999',
      '2004,6.12121212,5.34343434,4.56565656',
      '2005,3.98989898,2.87878787,1.76767676',
    ];

    const cand60 = writeText('c60.csv', `${BASELINE_HEADER}\n${[...rows.slice(0, 6), ...fresh.slice(0, 4)].join('\n')}`);
    const [decision60, , score60] = await decideExportReview(cand60);
    expect(score60).not.toBeNull();
    expect(Math.round(score60! * 100) / 100).toBeCloseTo(0.60, 1);
    expect(decision60).toBe('review');

    const cand50 = writeText('c50.csv', `metric,value\n${[...rows.slice(0, 5), ...fresh].join('\n')}`);
    const [decision50, , score50] = await decideExportReview(cand50);
    expect(score50!).toBeLessThan(0.6);
    expect(decision50).toBe('auto');
  });

  it('图片：不参与比对，直接免审', async () => {
    const baseline = useBaseline();
    const cand = writeBytes('plot.png', Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from(Array.from({ length: 256 }, (_u, i) => i)),
      Buffer.from(Array.from({ length: 256 }, (_u, i) => i)),
      Buffer.from(Array.from({ length: 256 }, (_u, i) => i)),
      Buffer.from(Array.from({ length: 256 }, (_u, i) => i)),
    ]));

    const [score] = await similarityToDataset(cand, baseline);
    expect(score).toBeNull();
    expect((await decideExportReview(cand))[0]).toBe('auto');
  });

  it('A2：统计软件原生格式/压缩包一律转人工', async () => {
    useBaseline();
    const dta = writeBytes('data.dta', Buffer.concat([
      Buffer.from('<stata dta binary>', 'utf8'),
      Buffer.from(Array.from({ length: 256 }, (_u, i) => i)),
    ]));
    const rds = writeBytes('model.rds', Buffer.concat([
      Buffer.from('X\n', 'utf8'),
      Buffer.from(Array.from({ length: 256 }, (_u, i) => i)),
    ]));
    const zipped = writeBytes('archive.zip', Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.alloc(64),
    ]));

    expect((await decideExportReview(dta))[0]).toBe('review');
    expect((await decideExportReview(rds))[0]).toBe('review');
    expect((await decideExportReview(zipped))[0]).toBe('review');
  });

  it('A2：未知类型直接拒绝', async () => {
    useBaseline();
    const cand = writeBytes('payload.exe', Buffer.concat([Buffer.from('MZ', 'utf8'), Buffer.alloc(64)]));

    const [decision, reason, score] = await decideExportReview(cand);
    expect(decision).toBe('reject');
    expect(score).toBeNull();
    expect(reason).toContain('不允许');
  });

  it('A2：二进制伪装成 .txt → 识别为二进制，转人工', async () => {
    const baseline = useBaseline();
    const blob = Buffer.from(Array.from({ length: 8 })
      .flatMap(() => Array.from({ length: 256 }, (_u, i) => i)));
    const cand = writeBytes('fake.txt', blob);

    const [score] = await similarityToDataset(cand, baseline);
    expect(score).toBeNull();
    expect((await decideExportReview(cand))[0]).toBe('review');
  });

  it('A2：原始数据 Base64 编码后导出 → 解码命中基线，转人工', async () => {
    useBaseline();
    const payload = `${BASELINE_HEADER}\n${baselineRows().slice(0, 10).join('\n')}`;
    const cand = writeText('encoded.txt', Buffer.from(payload, 'utf8').toString('base64'));

    const [decision, , score] = await decideExportReview(cand);
    expect(decision).toBe('review');
    expect(score).not.toBeNull();
    expect(score!).toBeGreaterThanOrEqual(0.6);
  });

  it('A2：加密/压缩内容再 Base64 → 视为混淆，转人工', async () => {
    const baseline = useBaseline();
    const blob = Buffer.from(Array.from({ length: 8 })
      .flatMap(() => Array.from({ length: 256 }, (_u, i) => i)));
    const cand = writeText('blob.txt', blob.toString('base64'));

    const [score] = await similarityToDataset(cand, baseline);
    expect(score).toBeNull();
    expect((await decideExportReview(cand))[0]).toBe('review');
  });

  it('A2：PDF 可能内嵌数据表，一律转人工', async () => {
    useBaseline();
    const cand = writeBytes('report.pdf', Buffer.concat([
      Buffer.from('%PDF-1.7\n', 'utf8'),
      Buffer.from(Array.from({ length: 100 }).flatMap(() => [0x00, 0x01, 0x62, 0x69, 0x6e, 0x61, 0x72, 0x79])),
    ]));

    const [decision, , score] = await decideExportReview(cand);
    expect(decision).toBe('review');
    expect(score).toBeNull();
  });

  it('基线缺失 → 安全默认转人工', async () => {
    overrideSettings({ datasetCsvPath: join(tmpDir, 'nope.csv') });
    const cand = writeText('r.csv', 'anything\n1,2,3\n');

    const [score, reason] = await similarityToDataset(cand);
    expect(score).toBeNull();
    expect(reason).toContain('基线');
    expect((await decideExportReview(cand))[0]).toBe('review');
  });

  it('空文件相似度为 0，decide 层判定免审（规则审查在 API 层叠加）', async () => {
    useBaseline();
    const cand = writeText('empty.csv', '');

    const [score] = await similarityToDataset(cand);
    expect(score).toBe(0);
    expect((await decideExportReview(cand))[0]).toBe('auto');
  });

  it('GBK 编码的基线与候选文件仍能正确比对', async () => {
    const base = join(tmpDir, 'gbk.csv');
    const rows = ['编号,指标甲,指标乙'];
    for (let i = 0; i < 20; i += 1) {
      rows.push(`${i},患者值甲${i}.${String(i).padStart(4, '0')},乙值${i}.${String(i).padStart(5, '0')}`);
    }
    // iconv-lite 的 'gbk' 编解码等价于 Python 的 .encode('gbk') / .decode('gbk')
    writeFileSync(base, iconv.encode(rows.join('\n'), 'gbk'));

    const candRows = [rows[0]!, ...rows.slice(1, 9)];
    const cand = writeBytes('c.csv', iconv.encode(candRows.join('\n'), 'gbk'));

    overrideSettings({ datasetCsvPath: base });
    resetBaselineCache();

    const [score] = await similarityToDataset(cand, base);
    expect(score).not.toBeNull();
    expect(score!).toBeGreaterThanOrEqual(0.9);
    expect((await decideExportReview(cand))[0]).toBe('review');
  });

  it('xlsx 可提取文本参与比对，但作为文档类型一律转人工', async () => {
    useBaseline();
    const ExcelJS = await import('exceljs');
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Sheet1');
    sheet.addRow(['metric', 'estimate']);
    sheet.addRow(['zzz_special_coef', 9.87654321]);
    sheet.addRow(['yyy_special_se', 8.7654321]);

    const path = join(tmpDir, 'book.xlsx');
    await workbook.xlsx.writeFile(path);

    const text = await extractComparableText(path);
    expect(text).not.toBeNull();
    expect(text).toContain('zzz_special_coef');

    const [score] = await similarityToDataset(path);
    expect(score).not.toBeNull();
    expect(score!).toBeLessThan(0.6);

    const [decision, reason] = await decideExportReview(path);
    expect(decision).toBe('review');
    expect(reason).toContain('人工审核');
  });
});

/* ============================================================
 * API：/results/request-export 端到端
 * ============================================================ */

describe('POST /results/request-export 端到端', () => {
  let app: FastifyInstance;
  let user: Awaited<ReturnType<typeof seedUser>>;
  let pendingDir: string;

  const exportFiles = (names: readonly string[]) => request(app, {
    method: 'POST',
    url: '/results/request-export',
    user,
    payload: { file_names: [...names] },
  });

  beforeEach(async () => {
    await resetDatabase();
    app ??= await buildTestApp();
    user = await seedUser({ username: 'user1' });

    pendingDir = join(getSettings().fileserverRoot, 'pending', String(user.id));
    rmSync(pendingDir, { recursive: true, force: true });
    mkdirSync(pendingDir, { recursive: true });
    tmpDir = mkdtempSync(join(tmpdir(), 'stats_sim_api_'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  afterAll(async () => {
    await app?.close();
  });

  const putPending = (name: string, content: Buffer | string): void => {
    writeFileSync(join(pendingDir, name), content);
  };

  it('低相似度：自动发布且可下载（内容与原文一致）', async () => {
    useBaseline();
    const blob = Buffer.from('metric,value\nzzz_rmsea,9.87654321\nyyy_cfi,8.76543210\n', 'utf8');
    putPending('analysis_result.csv', blob);

    const body = (await exportFiles(['analysis_result.csv']))
      .json<{ auto_approved: number; registered: number; auto_files: { file_name: string }[] }>();
    expect(body.auto_approved).toBe(1);
    expect(body.registered).toBe(0);
    expect(body.auto_files[0]!.file_name).toBe('analysis_result.csv');

    const mine = (await request(app, { method: 'GET', url: '/results/mine', user }))
      .json<{ pending: { status: string }[]; published: { result_name: string; id: number }[] }>();
    expect(mine.pending.every((item) => item.status === 'approved')).toBe(true);
    expect(mine.published.map((item) => item.result_name)).toEqual(['analysis_result.csv']);

    const download = await request(app, {
      method: 'POST', url: `/results/${mine.published[0]!.id}/download`, user,
    });
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload.equals(blob)).toBe(true);
  });

  it('高相似度：维持待审，不产生下载入口', async () => {
    useBaseline();
    putPending('raw_slice.csv', `${BASELINE_HEADER}\n${baselineRows().slice(0, 10).join('\n')}`);

    const body = (await exportFiles(['raw_slice.csv']))
      .json<{ registered: number; auto_approved: number; files: { reason: string }[] }>();
    expect(body.registered).toBe(1);
    expect(body.auto_approved).toBe(0);
    expect(body.files[0]!.reason).toContain('60%');

    const mine = (await request(app, { method: 'GET', url: '/results/mine', user }))
      .json<{ pending: { file_name: string }[]; published: unknown[] }>();
    expect(mine.pending.map((item) => item.file_name)).toEqual(['raw_slice.csv']);
    expect(mine.published).toEqual([]);

    expect((await request(app, { method: 'POST', url: '/results/999999/download', user })).statusCode)
      .toBe(404);
  });

  it('PNG 无基线也免审（图片不参与比对）', async () => {
    putPending('diagram.png', Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from(Array.from({ length: 64 }, (_u, i) => i)),
    ]));

    const body = (await exportFiles(['diagram.png']))
      .json<{ auto_approved: number; registered: number }>();
    expect(body.auto_approved).toBe(1);
    expect(body.registered).toBe(0);
  });

  it('基线缺失的文本文件 → 转人工，原因含「基线」', async () => {
    putPending('notes.txt', 'some analysis text that cannot be judged\n');

    const body = (await exportFiles(['notes.txt']))
      .json<{ registered: number; auto_approved: number; files: { reason: string }[] }>();
    expect(body.registered).toBe(1);
    expect(body.auto_approved).toBe(0);
    expect(body.files[0]!.reason).toContain('基线');
  });

  it('混合批次：高相似转人工、低相似与图片自动发布', async () => {
    useBaseline('baseline2.csv');
    putPending('raw.csv', `${BASELINE_HEADER}\n${baselineRows().slice(0, 6).join('\n')}`);
    putPending('summary.csv', 'metric,value\nzzz_unique,5.55555555\nyyy_unique,4.44444444\n');
    putPending('img.png', Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('binary', 'utf8'),
    ]));

    const body = (await exportFiles(['raw.csv', 'summary.csv', 'img.png']))
      .json<{ registered: number; auto_approved: number }>();
    expect(body.registered).toBe(1);
    expect(body.auto_approved).toBe(2);

    const mine = (await request(app, { method: 'GET', url: '/results/mine', user }))
      .json<{ pending: { file_name: string; status: string }[]; published: { result_name: string }[] }>();
    expect(mine.pending.filter((item) => item.status === 'pending').map((item) => item.file_name))
      .toEqual(['raw.csv']);
    expect(mine.published.map((item) => item.result_name).sort()).toEqual(['img.png', 'summary.csv']);
  });

  it('A2：.dta 统计软件原生格式转人工，不发布也不拒绝', async () => {
    useBaseline('baseline3.csv');
    putPending('export.dta', Buffer.concat([
      Buffer.from('<stata dta>', 'utf8'),
      Buffer.from(Array.from({ length: 256 }, (_u, i) => i)),
    ]));

    const body = (await exportFiles(['export.dta']))
      .json<{ registered: number; auto_approved: number; rejected: number }>();
    expect(body.registered).toBe(1);
    expect(body.auto_approved).toBe(0);
    expect(body.rejected).toBe(0);

    const mine = (await request(app, { method: 'GET', url: '/results/mine', user }))
      .json<{ pending: { file_name: string }[]; published: unknown[] }>();
    expect(mine.published).toEqual([]);
    expect(mine.pending.map((item) => item.file_name)).toEqual(['export.dta']);
  });

  it('A2：未知类型直接拒绝并登记为 rejected', async () => {
    putPending('tool.exe', Buffer.concat([Buffer.from('MZ', 'utf8'), Buffer.alloc(64)]));

    const body = (await exportFiles(['tool.exe']))
      .json<{
        rejected: number;
        rejected_files: { file_name: string }[];
        auto_approved: number;
      }>();
    expect(body.rejected).toBe(1);
    expect(body.rejected_files[0]!.file_name).toBe('tool.exe');
    expect(body.auto_approved).toBe(0);

    const mine = (await request(app, { method: 'GET', url: '/results/mine', user }))
      .json<{ pending: { status: string }[]; published: unknown[] }>();
    expect(mine.published).toEqual([]);
    expect(mine.pending.map((item) => item.status)).toEqual(['rejected']);
  });

  it('B8：空 CSV 相似度为 0，但规则审查不通过 → 转人工', async () => {
    useBaseline('baseline4.csv');
    putPending('empty.csv', Buffer.alloc(0));

    const body = (await exportFiles(['empty.csv']))
      .json<{ registered: number; auto_approved: number; files: { reason: string }[] }>();
    expect(body.registered).toBe(1);
    expect(body.auto_approved).toBe(0);
    expect(body.files[0]!.reason).toContain('空');

    const mine = (await request(app, { method: 'GET', url: '/results/mine', user }))
      .json<{ published: unknown[] }>();
    expect(mine.published).toEqual([]);
  });
});
