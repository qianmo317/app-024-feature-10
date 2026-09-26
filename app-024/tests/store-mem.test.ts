// 无 IndexedDB 环境：自动降级内存模式，必须显式标记「刷新即丢失」
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { store } from '../src/lib/store';

// 本文件刻意不 import fake-indexeddb：node 环境没有 indexedDB 全局，模拟无本机数据库的环境
const hadGlobal = typeof globalThis.indexedDB !== 'undefined';
let saved: unknown;
beforeAll(() => {
  if (hadGlobal) {
    saved = globalThis.indexedDB;
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
  }
});
afterAll(() => {
  if (hadGlobal) (globalThis as { indexedDB?: unknown }).indexedDB = saved;
});

describe('无 IndexedDB → 内存降级', () => {
  it('init 后 storageMode=mem 且有 memory 告警', async () => {
    await store.init();
    const s = store.getState();
    expect(s.ready).toBe(true);
    expect(s.storageMode).toBe('mem');
    expect(s.persistIssue?.kind).toBe('memory');
  });

  it('每次写入后仍标记内存告警（提醒先导出备份再继续）', async () => {
    await store.addRiddles([
      { surface: '内存谜条', answer: 'x', category: 'char', format: 'none', difficulty: 2, tags: [] },
    ]);
    const s = store.getState();
    expect(s.riddles).toHaveLength(1);
    expect(s.persistIssue?.kind).toBe('memory');
    await store.addRecord({ riddleId: s.riddles[0].id, prize: '参与奖' });
    expect(store.getState().records).toHaveLength(1);
    expect(store.getState().persistIssue?.kind).toBe('memory');
  });
});
