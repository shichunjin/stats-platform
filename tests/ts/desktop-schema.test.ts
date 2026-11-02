/**
 * 云桌面 schema 冒烟测试 —— docs/multi-vm-desktop-plan.md 第 7 章
 *
 * 迁移 0001 已在 setup.ts 的 runMigrations() 里应用（PGlite = 真实 PostgreSQL，
 * 部分唯一索引 / FOR UPDATE SKIP LOCKED 都是真生效）。
 * 这里锁的是**结构性约束**，不是业务流程（业务流程等 DMS 代码就绪后再测）：
 *  - uq_desk_instances_active_user：一人一活跃桌面；error/destroyed 释放占位
 *  - uq_desktop_vms_ref：Provider ref 复用防护；destroyed 后可复用
 *  - uq_desktop_templates_default：最多一个默认模板
 *  - desktop_tasks 队列 SQL：SKIP LOCKED 取任务并转移到 running
 *  - users 桌面扩展列默认值：desktop_mode='rds'（不改变现有行为）
 */
import { eq } from 'drizzle-orm';
import type { QueryResultRow } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '../../src/db/client.js';
import {
  deskInstances, desktopQuotas, desktopTasks, desktopTemplates, desktopVms, users,
} from '../../src/db/schema.js';
import { withSession } from '../../src/db/session.js';
import { seedUser } from './helpers.js';
import { resetDatabase } from './setup.js';

const insertTemplate = (overrides: Partial<typeof desktopTemplates.$inferInsert> = {}) =>
  withSession(async (db) => {
    const [row] = await db.db.insert(desktopTemplates).values({
      code: 'win2022-stats-v1',
      name: '统计软件桌面 v1',
      provider: 'proxmox',
      providerRef: 'node=pve1,vmid=9001',
      vcpu: 4,
      memoryMb: 8192,
      diskGb: 120,
      isDefault: true,
      ...overrides,
    }).returning();
    await db.commit();
    return row!;
  });

const insertInstance = (
  userId: number,
  templateId: number,
  overrides: Partial<typeof deskInstances.$inferInsert> = {},
) => withSession(async (db) => {
  const [row] = await db.db.insert(deskInstances).values({
    userId,
    templateId,
    ...overrides,
  }).returning();
  await db.commit();
  return row!;
});

beforeEach(resetDatabase);

afterAll(async () => {
  await getPool().end();
});

describe('users 桌面扩展列（7.1）', () => {
  it('默认值：desktop_mode=rds、desktop_enabled=true、desktop_quota_id 为空', async () => {
    const user = await seedUser({ username: 'alice' });
    expect(user.desktopMode).toBe('rds');
    expect(user.desktopEnabled).toBe(true);
    expect(user.desktopQuotaId).toBeNull();
  });

  it('配额外键可挂到 users.desktop_quota_id（set null 回滚路径）', async () => {
    await seedUser({ username: 'alice' });
    const tpl = await insertTemplate();
    const [quota] = await withSession(async (db) => {
      const rows = await db.db.insert(desktopQuotas).values({
        code: 'default',
        name: '默认档',
        defaultVcpu: 2,
        defaultMemoryMb: 4096,
        templateId: tpl.id,
      }).returning();
      await db.commit();
      return rows;
    });
    const user = await withSession(async (db) => {
      const rows = await db.db.update(users)
        .set({ desktopQuotaId: quota!.id, desktopMode: 'vm' })
        .where(eq(users.username, 'alice'))
        .returning();
      await db.commit();
      return rows[0]!;
    });
    expect(user.desktopMode).toBe('vm');
    expect(user.desktopQuotaId).toBe(quota!.id);
  });
});

describe('uq_desk_instances_active_user（一人一活跃桌面）', () => {
  it('同用户第二个活跃实例被部分唯一索引拒绝', async () => {
    const user = await seedUser({ username: 'alice' });
    const tpl = await insertTemplate();
    await insertInstance(user.id, tpl.id);
    await expect(insertInstance(user.id, tpl.id)).rejects.toThrow(/unique|duplicate/i);
  });

  it('destroyed / error 状态释放占位，可重新分配', async () => {
    const user = await seedUser({ username: 'alice' });
    const tpl = await insertTemplate();
    await insertInstance(user.id, tpl.id, { status: 'destroyed' });
    await insertInstance(user.id, tpl.id, { status: 'error' });
    // 前两条不占活跃位，第三条应成功
    const active = await insertInstance(user.id, tpl.id);
    expect(active.status).toBe('new');
  });

  it('failed 仍占位（须人工/自动恢复后才能重新分配）', async () => {
    const user = await seedUser({ username: 'alice' });
    const tpl = await insertTemplate();
    await insertInstance(user.id, tpl.id, { status: 'failed' });
    await expect(insertInstance(user.id, tpl.id)).rejects.toThrow(/unique|duplicate/i);
  });
});

describe('uq_desktop_vms_ref（Provider ref 复用防护）', () => {
  it('活跃 VM 的 provider+ref 唯一；destroyed 后 ref 可复用', async () => {
    const tpl = await insertTemplate();
    await withSession(async (db) => {
      await db.db.insert(desktopVms).values({
        templateId: tpl.id, provider: 'proxmox', providerRef: '9101', name: 'DESK-alice',
      });
      await db.commit();
    });
    // 同 ref 未销毁 → 拒绝
    await expect(withSession(async (db) => {
      await db.db.insert(desktopVms).values({
        templateId: tpl.id, provider: 'proxmox', providerRef: '9101', name: 'DESK-alice-2',
      });
      await db.commit();
    })).rejects.toThrow(/unique|duplicate/i);

    // 标记销毁后 → 同 ref 可复用
    await withSession(async (db) => {
      await db.db.update(desktopVms)
        .set({ destroyedAt: new Date() })
        .where(eq(desktopVms.providerRef, '9101'));
      await db.commit();
    });
    const [revived] = await withSession(async (db) => {
      const rows = await db.db.insert(desktopVms).values({
        templateId: tpl.id, provider: 'proxmox', providerRef: '9101', name: 'DESK-bob',
      }).returning();
      await db.commit();
      return rows;
    });
    expect(revived!.destroyedAt).toBeNull();
  });

  it('desk_instances ↔ desktop_vms 循环外键可双向落库', async () => {
    const user = await seedUser({ username: 'alice' });
    const tpl = await insertTemplate();
    const instance = await insertInstance(user.id, tpl.id);
    const [vm] = await withSession(async (db) => {
      const rows = await db.db.insert(desktopVms).values({
        instanceId: instance.id,
        templateId: tpl.id,
        provider: 'proxmox',
        providerRef: '9101',
        name: 'DESK-alice',
        primaryIp: '10.20.3.11',
      }).returning();
      await db.commit();
      return rows;
    });
    const [bound] = await withSession(async (db) => {
      const rows = await db.db.update(deskInstances)
        .set({ currentVmId: vm!.id, status: 'ready' })
        .where(eq(deskInstances.id, instance.id))
        .returning();
      await db.commit();
      return rows;
    });
    expect(bound!.currentVmId).toBe(vm!.id);
  });
});

describe('uq_desktop_templates_default', () => {
  it('最多一个 is_default=true 模板', async () => {
    await insertTemplate();
    await expect(
      insertTemplate({ code: 'win2022-stats-v2', providerRef: 'node=pve1,vmid=9002' }),
    ).rejects.toThrow(/unique|duplicate/i);
  });
});

describe('desktop_tasks 队列（7.8 取任务 SQL）', () => {
  interface ClaimedTaskRow extends QueryResultRow {
    readonly status: string;
    readonly attempts: number | string;
    readonly task_key: string;
  }

  it('FOR UPDATE SKIP LOCKED 取出 pending 任务并转移到 running', async () => {
    const user = await seedUser({ username: 'alice' });
    const tpl = await insertTemplate();
    const instance = await insertInstance(user.id, tpl.id);
    await withSession(async (db) => {
      await db.db.insert(desktopTasks).values({
        taskKey: 'ensure:user:1:2026-11-02',
        type: 'create',
        instanceId: instance.id,
        userId: user.id,
      });
      await db.commit();
    });

    const { rows } = await getPool().query<ClaimedTaskRow>(`
      WITH next AS (
        SELECT id FROM desktop_tasks
        WHERE status='pending' AND not_before <= now()
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE desktop_tasks SET status='running', started_at=now(), attempts=attempts+1
      WHERE id IN (SELECT id FROM next)
      RETURNING id, status, attempts;
    `);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('running');
    expect(Number(rows[0]!.attempts)).toBe(1);
  });

  it('not_before 未到期 / 非 pending 的任务不进队列', async () => {
    const user = await seedUser({ username: 'alice' });
    const tpl = await insertTemplate();
    const instance = await insertInstance(user.id, tpl.id);
    const future = new Date(Date.now() + 60_000);
    const past = new Date(Date.now() - 60_000);
    await withSession(async (db) => {
      await db.db.insert(desktopTasks).values([
        { taskKey: 'backoff', type: 'create', instanceId: instance.id, notBefore: future },
        { taskKey: 'done', type: 'probe', instanceId: instance.id, status: 'success' },
        { taskKey: 'ready-to-run', type: 'create', instanceId: instance.id, notBefore: past },
      ]);
      await db.commit();
    });

    const { rows } = await getPool().query<ClaimedTaskRow>(`
      WITH next AS (
        SELECT id FROM desktop_tasks
        WHERE status='pending' AND not_before <= now()
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE desktop_tasks SET status='running', started_at=now()
      WHERE id IN (SELECT id FROM next)
      RETURNING task_key;
    `);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.task_key).toBe('ready-to-run');
  });
});
