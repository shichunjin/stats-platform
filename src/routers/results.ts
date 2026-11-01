/**
 * 结果路由 —— app/routers/results.py
 * GET /results/mine, GET /results/pending-files, POST /results/request-export,
 * POST /results/:result_id/download
 */
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { HttpError, authenticate } from '../auth/guards.js';
import { recordAudit } from '../audit.js';
import { getSettings } from '../config/env.js';
import { exportResults, pendingFiles, type PendingFile, type User } from '../db/schema.js';
import {
  decideExportReview, fileSha256, reviewResult, scanPendingDirectory,
} from '../services/review.js';
import { downloadFileFromWindows, listRemoteFiles } from '../integrations/transfer.js';
import { getClientIp } from '../security/rate-limit.js';
import {
  exportResultOutSchema, pendingFileOutSchema, toExportResultOut, toPendingFileOut,
} from '../schemas/index.js';
import { asRouteSchema } from '../plugins/validator.js';

/** Windows 文件名白名单（禁止路径分隔符等），防御远端异常文件名穿越本地目录 */
const SAFE_REMOTE_NAME = /^[^\\/:*?"<>|]+$/;
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg']);

const userPendingDir = (userId: number): string =>
  join(getSettings().fileserverRoot, 'pending', String(userId));

const publishedDir = async (resultId: number): Promise<string> => {
  const dir = join(getSettings().fileserverRoot, 'published', String(resultId));
  await mkdir(dir, { recursive: true });
  return dir;
};

/** 把 Windows 上 C:\pending\{用户名} 的结果文件增量回拉到本地 */
export const pullUserPending = async (user: User, localDir: string): Promise<readonly string[]> => {
  const { windowsPendingDir } = getSettings();
  const remoteDir = `${windowsPendingDir.replace(/\/$/, '')}/${user.username}`;
  await mkdir(localDir, { recursive: true });

  const pulled: string[] = [];
  for (const { filename, size } of await listRemoteFiles(remoteDir)) {
    if (filename === '.' || filename === '..' || !SAFE_REMOTE_NAME.test(filename)) continue;

    const localPath = join(localDir, filename);
    try {
      const stats = await stat(localPath);
      // 同名且大小一致视为未变化，跳过重复下载
      if (stats.size === size) continue;
    } catch {
      // 本地不存在，需要下载
    }
    await downloadFileFromWindows(remoteDir, filename, localPath);
    pulled.push(localPath);
  }
  return pulled;
};

const requestExportSchema = z.object({
  file_names: z.array(z.string().min(1)).min(1).max(200)
    .openapi({ description: '要导出的文件名（仅限本人待导出目录内的文件）' }),
}).strict();

const resultIdSchema = z.object({ result_id: z.coerce.number().int().positive() }).strict();

const pendingFileEntrySchema = z.object({
  file_name: z.string(),
  file_size: z.number().int(),
  modified_at: z.string(),
  file_type: z.string().nullable(),
  already_requested: z.boolean(),
  existing_status: z.string().nullable(),
});

const decisionEntrySchema = z.object({
  id: z.number().int(),
  file_name: z.string(),
  status: z.string(),
  reason: z.string(),
  result_id: z.number().int().optional(),
});

export const resultsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/results/mine', {
    schema: asRouteSchema({
      response: {
        200: z.object({
          pending: z.array(pendingFileOutSchema),
          published: z.array(exportResultOutSchema),
        }),
      },
    }),
    preHandler: [authenticate],
  }, async (request) => {
    const user = request.user as User;

    return app.withDb(async (db) => {
      const pending = await db.db.select().from(pendingFiles)
        .where(eq(pendingFiles.userId, user.id))
        .orderBy(desc(pendingFiles.createdAt));

      const published = await db.db.select().from(exportResults)
        .where(eq(exportResults.userId, user.id))
        .orderBy(desc(exportResults.createdAt));

      return {
        pending: pending.map(toPendingFileOut),
        published: published.map(toExportResultOut),
      };
    });
  });

  app.get('/results/pending-files', {
    schema: asRouteSchema({
      response: { 200: z.object({ files: z.array(pendingFileEntrySchema) }) },
    }),
    preHandler: [authenticate],
  }, async (request) => {
    const user = request.user as User;
    const pendingDir = userPendingDir(user.id);

    try {
      await pullUserPending(user, pendingDir);
    } catch (error) {
      throw new HttpError(502, `无法从 Windows 云平台读取待导出文件: ${error instanceof Error ? error.message : String(error)}`);
    }

    return app.withDb(async (db) => {
      const files: z.infer<typeof pendingFileEntrySchema>[] = [];

      for (const filePath of await scanPendingDirectory(pendingDir)) {
        const fileName = basename(filePath);
        let fileSize: number;
        let modifiedAt: Date;
        let sha: string;
        try {
          const stats = await stat(filePath);
          fileSize = stats.size;
          modifiedAt = stats.mtime;
          sha = await fileSha256(filePath);
        } catch {
          continue;
        }

        const [existing] = await db.db.select().from(pendingFiles)
          .where(and(
            eq(pendingFiles.userId, user.id),
            eq(pendingFiles.fileName, fileName),
            eq(pendingFiles.contentSha, sha),
            inArray(pendingFiles.status, ['pending', 'approved']),
          ))
          .limit(1);

        files.push({
          file_name: fileName,
          file_size: fileSize,
          modified_at: new Date(modifiedAt).toISOString(),
          file_type: extname(fileName).toLowerCase().replace(/^\./, '') || null,
          already_requested: existing !== undefined,
          existing_status: existing?.status ?? null,
        });
      }

      files.sort((a, b) => b.modified_at.localeCompare(a.modified_at));
      return { files };
    });
  });

  app.post<{ Body: z.infer<typeof requestExportSchema> }>('/results/request-export', {
    schema: asRouteSchema({
      body: requestExportSchema,
      response: {
        200: z.object({
          registered: z.number().int(),
          files: z.array(decisionEntrySchema),
          auto_approved: z.number().int(),
          auto_files: z.array(decisionEntrySchema),
          rejected: z.number().int(),
          rejected_files: z.array(decisionEntrySchema),
          skipped: z.array(z.string()),
          not_found: z.array(z.string()),
        }),
      },
    }),
    preHandler: [authenticate],
  }, async (request) => {
    const user = request.user as User;
    const clientIp = getClientIp(request);

    // 文件名安全校验：仅允许普通文件名，防止路径穿越
    const requested = [...new Set(
      request.body.file_names
        .map((name) => name.trim())
        .filter((name) => name && name !== '.' && name !== '..' && SAFE_REMOTE_NAME.test(name)),
    )];
    if (requested.length === 0) throw new HttpError(422, '请选择要导出的文件');

    const pendingDir = userPendingDir(user.id);
    try {
      await pullUserPending(user, pendingDir);
    } catch (error) {
      throw new HttpError(502, `无法从 Windows 云平台读取待导出文件: ${error instanceof Error ? error.message : String(error)}`);
    }

    const scanned = await scanPendingDirectory(pendingDir);
    const available = new Map(scanned.map((path) => [basename(path), path]));
    const targets = requested.map((name) => available.get(name)).filter((v): v is string => Boolean(v));
    const notFound = requested.filter((name) => !available.has(name));

    return app.withDb(async (db) => {
      const { exportPublishValidDays } = getSettings();
      const needReview: z.infer<typeof decisionEntrySchema>[] = [];
      const autoApproved: z.infer<typeof decisionEntrySchema>[] = [];
      const rejected: z.infer<typeof decisionEntrySchema>[] = [];
      const skipped: string[] = [];

      for (const filePath of targets) {
        const fileName = basename(filePath);

        // B9：以内容哈希判重 —— 仅「同名 + 同内容 + pending/approved」才跳过；
        // rejected 的同名文件允许重新申请（视为修正后重提）
        const sha = await fileSha256(filePath);
        const [existing] = await db.db.select({ id: pendingFiles.id }).from(pendingFiles)
          .where(and(
            eq(pendingFiles.userId, user.id),
            eq(pendingFiles.fileName, fileName),
            eq(pendingFiles.contentSha, sha),
            inArray(pendingFiles.status, ['pending', 'approved']),
          ))
          .limit(1);
        if (existing) {
          skipped.push(fileName);
          continue;
        }

        const stats = await stat(filePath);
        const insert = {
          userId: user.id,
          fileName,
          filePath,
          fileSize: stats.size,
          fileType: extname(fileName).toLowerCase().replace(/^\./, ''),
          status: 'pending' as const,
          contentSha: sha,
        };

        // 唯一索引 ix_pending_files_active 兜底并发重复申请（B9）：
        // 冲突时回滚保存点并跳过本文件，不影响本次请求中其他文件
        let created: PendingFile;
        try {
          const rows = await db.beginNested(async () => {
            const inserted = await db.db.insert(pendingFiles).values(insert).returning();
            return inserted;
          });
          created = rows[0]!;
        } catch {
          continue;
        }

        let decision = await decideExportReview(filePath);
        const [, reason] = decision;

        // B8：免审自动发布前必须再过规则审查（图片类不含行级数据，跳过）
        if (decision[0] === 'auto' && !IMAGE_EXTS.has(extname(fileName).toLowerCase())) {
          const [ok, ruleReason] = await reviewResult(filePath);
          if (!ok) decision = ['review', `${ruleReason}；转管理员人工审核`, decision[2]];
        }

        if (decision[0] === 'reject') {
          await db.db.update(pendingFiles)
            .set({ status: 'rejected', reviewReason: decision[1] })
            .where(eq(pendingFiles.id, created.id));

          await recordAudit(db, {
            userId: user.id,
            action: 'export_rejected',
            detail: `导出被拒绝 ${fileName} (id=${created.id})：${decision[1]}`,
            ipAddr: clientIp,
          });
          rejected.push({ id: created.id, file_name: fileName, status: 'rejected', reason: decision[1] });
          continue;
        }

        if (decision[0] === 'auto') {
          const dir = await publishedDir(created.id);
          const pubPath = join(dir, fileName);
          await copyFile(filePath, pubPath);

          const [published] = await db.db.insert(exportResults).values({
            userId: created.userId,
            pendingFileId: created.id,
            resultName: fileName,
            filePath: pubPath,
            fileSize: created.fileSize,
            expiresAt: new Date(Date.now() + exportPublishValidDays * 86_400_000),
          }).returning();

          await db.db.update(pendingFiles)
            .set({ status: 'approved', reviewReason: decision[1], reviewedAt: new Date() })
            .where(eq(pendingFiles.id, created.id));

          await recordAudit(db, {
            userId: user.id,
            action: 'export_auto_approved',
            detail: `免审核自动通过导出 ${fileName} (id=${created.id})：${decision[1]}`,
            ipAddr: clientIp,
          });
          autoApproved.push({
            id: created.id, file_name: fileName, status: 'approved', result_id: published!.id, reason: decision[1],
          });
          continue;
        }

        await db.db.update(pendingFiles)
          .set({ reviewReason: decision[1] })
          .where(eq(pendingFiles.id, created.id));
        needReview.push({ id: created.id, file_name: fileName, status: 'pending', reason: reason ?? decision[1] });
      }

      if (needReview.length > 0) {
        await recordAudit(db, {
          userId: user.id,
          action: 'export_requested',
          detail: `申请导出 ${needReview.length} 个高相似度文件，等待管理员审核: ${needReview.map((r) => r.file_name).join(', ')}`,
          ipAddr: clientIp,
        });
      }

      await db.commit();

      return {
        registered: needReview.length,
        files: needReview,
        auto_approved: autoApproved.length,
        auto_files: autoApproved,
        rejected: rejected.length,
        rejected_files: rejected,
        skipped,
        not_found: notFound,
      };
    });
  });

  app.post('/results/:result_id/download', {
    schema: asRouteSchema({ params: resultIdSchema }),
    preHandler: [authenticate],
  }, async (request, reply) => {
    const user = request.user as User;
    const { result_id: resultId } = request.params as z.infer<typeof resultIdSchema>;
    const clientIp = getClientIp(request);

    const stream = await app.withDb(async (db) => {
      const [exp] = await db.db.select().from(exportResults)
        .where(and(eq(exportResults.id, resultId), eq(exportResults.userId, user.id)))
        .limit(1);

      if (!exp) throw new HttpError(404, '结果不存在或无权访问');

      // 数据归属 + 有效期校验
      if (exp.expiresAt !== null && exp.expiresAt.getTime() < Date.now()) {
        await recordAudit(db, {
          userId: user.id,
          action: 'result_download_expired',
          detail: `下载被拒绝（已过期）：${exp.resultName} (id=${resultId})`,
          status: 'failed',
          ipAddr: clientIp,
        });
        await db.commit();
        throw new HttpError(410, '文件已过期，无法下载');
      }

      let exists = true;
      try {
        await stat(exp.filePath);
      } catch {
        exists = false;
      }
      if (!exists) throw new HttpError(404, '文件不存在');

      await db.db.update(exportResults)
        .set({ downloadCount: exp.downloadCount + 1 })
        .where(eq(exportResults.id, resultId));

      await recordAudit(db, {
        userId: user.id,
        action: 'result_download',
        detail: `下载结果 ${exp.resultName} (id=${resultId})`,
        ipAddr: clientIp,
      });
      await db.commit();

      return { path: exp.filePath, name: exp.resultName };
    });

    return reply
      .header('Content-Type', 'application/octet-stream')
      .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(stream.name)}`)
      .send(createReadStream(stream.path));
  });
};
