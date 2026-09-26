// store 集成测试（fake-indexeddb）：写后核对、整包恢复、失败回滚
import { describe, it, expect, beforeAll, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { store } from '../src/lib/store';
import * as idb from '../src/lib/idb';
import { buildBackup, planImport } from '../src/lib/backup';
import type { Riddle } from '../src/types';

async function resetDB() {
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase('app-024-lantern-riddle');
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

function bare(surface: string, answer = '答') {
  return { surface, answer, category: 'char' as const, format: 'none' as const, difficulty: 2 as const, tags: [] };
}

describe('store 集成（fake-indexeddb）', () => {
  beforeAll(async () => {
    await resetDB();
    await store.init();
  });

  it('IndexedDB 模式下初始化无持久化告警', () => {
    const s = store.getState();
    expect(s.ready).toBe(true);
    expect(s.storageMode).toBe('idb');
    expect(s.persistIssue).toBeNull();
  });

  it('写入后核对：落库条数与内存一致，无告警', async () => {
    await store.addRiddles([bare('一口咬掉牛尾巴', '告'), bare('两人土上蹲', '坐')]);
    const s = store.getState();
    expect(s.riddles).toHaveLength(2);
    expect(s.persistIssue).toBeNull();
    expect(await idb.count(idb.STORE_RIDDLES)).toBe(2);
  });

  it('登记写入后核对一致', async () => {
    const r = store.getState().riddles[0];
    await store.addRecord({ riddleId: r.id, prize: '参与奖' });
    expect(store.getState().records).toHaveLength(1);
    expect(store.getState().persistIssue).toBeNull();
    expect(await idb.count(idb.STORE_RECORDS)).toBe(1);
  });

  it('整包恢复：预览计划 + applyBackup 合并写库并核对', async () => {
    const before = store.getState();
    const backup = buildBackup(
      [
        { ...before.riddles[0], surface: '改后的谜面' },          // 覆盖（同 id）
        { ...before.riddles[1], id: 'new-id-x', no: 99, surface: '外来谜条' }, // 新增（no 冲突→重排）
      ] as Riddle[],
      [{ id: 'rec-new', riddleId: 'new-id-x', prize: '三等奖', at: Date.now() }],
      { ...before.settings, event: { ...before.settings.event, title: '恢复后的灯会' } },
      'IndexedDB',
    );
    const plan = planImport(backup, before.riddles, before.records);
    expect(plan.freshRiddles).toHaveLength(1);
    expect(plan.overwriteRiddles).toHaveLength(1);
    // 库内最大谜号 2，外来谜条 no=99 不与保留项冲突，无需重排
    expect(plan.renumbered).toBe(0);
    const res = await store.applyBackup(plan);
    expect(res.ok).toBe(true);
    const after = store.getState();
    expect(after.riddles).toHaveLength(3);
    expect(after.riddles.find((r) => r.id === before.riddles[0].id)?.surface).toBe('改后的谜面');
    expect(after.records).toHaveLength(2);
    expect(after.settings.event.title).toBe('恢复后的灯会');
    expect(after.persistIssue).toBeNull();
    expect(await idb.count(idb.STORE_RIDDLES)).toBe(3);
    expect(await idb.count(idb.STORE_RECORDS)).toBe(2);
  });

  it('恢复失败回到导入前状态（内存与库都不变）', async () => {
    const before = store.getState();
    const backup = buildBackup([{ ...before.riddles[0], id: 'ghost', no: 50, surface: '不应出现' } as Riddle], [], before.settings, 'IndexedDB');
    const plan = planImport(backup, before.riddles, before.records);
    // 模拟写库失败（如磁盘配额耗尽 / 事务中止）：内存与数据库都必须保持导入前状态
    const spy = vi.spyOn(idb, 'restoreAll').mockResolvedValue(false);
    const res = await store.applyBackup(plan);
    spy.mockRestore();
    expect(res.ok).toBe(false);
    expect(res.error).toContain('导入前');
    const after = store.getState();
    expect(after.riddles).toEqual(before.riddles);
    expect(after.records).toEqual(before.records);
    expect(after.riddles.find((r) => r.id === 'ghost')).toBeUndefined();
    expect(await idb.count(idb.STORE_RIDDLES)).toBe(3);
  });
});
