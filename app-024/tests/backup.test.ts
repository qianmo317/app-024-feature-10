// 整包备份：构建 / 解析 / 预览 / 合并（新增·覆盖·重新编号·回滚口径）
import { describe, it, expect } from 'vitest';
import {
  buildBackup, parseBackup, previewBackup, mergeBackup,
  BACKUP_KIND, BACKUP_VERSION, type BackupData,
} from '../src/lib/backup';
import { DEFAULT_SETTINGS } from '../src/lib/store';
import type { AppSettings, OnsiteRecord, Riddle } from '../src/types';

function mkRiddle(id: string, no: number, surface = `谜面${id}`): Riddle {
  return {
    id, no, surface, answer: '告', category: 'char', format: 'none',
    difficulty: 2, tags: [], check: { verdict: 'pass', reasons: [], checkedAt: 1 },
  };
}

function mkRecord(id: string, riddleId: string, at = 100): OnsiteRecord {
  return { id, riddleId, prize: '参与奖', at };
}

function mkCurrent(over?: Partial<{ riddles: Riddle[]; records: OnsiteRecord[]; settings: AppSettings }>) {
  return {
    riddles: over?.riddles ?? [mkRiddle('a', 1), mkRiddle('b', 2)],
    records: over?.records ?? [mkRecord('r1', 'a')],
    settings: over?.settings ?? DEFAULT_SETTINGS,
  };
}

function mkBackup(over?: Partial<BackupData>): BackupData {
  return {
    kind: BACKUP_KIND,
    app: 'app-024-lantern-riddle-bank',
    version: BACKUP_VERSION,
    exportedAt: 1700000000000,
    source: '测试灯会 · 本机',
    counts: { riddles: 1, records: 1 },
    settings: null,
    riddles: [mkRiddle('c', 3)],
    records: [mkRecord('r2', 'c')],
    ...over,
  };
}

describe('buildBackup', () => {
  it('写明导出时间、条数与来源', () => {
    const cur = mkCurrent();
    cur.settings = { ...DEFAULT_SETTINGS, event: { ...DEFAULT_SETTINGS.event, title: '元宵灯会' } };
    const b = buildBackup(cur, 1234567890);
    expect(b.kind).toBe(BACKUP_KIND);
    expect(b.version).toBe(BACKUP_VERSION);
    expect(b.exportedAt).toBe(1234567890);
    expect(b.counts).toEqual({ riddles: 2, records: 1 });
    expect(b.source).toContain('元宵灯会');
    expect(b.riddles).toHaveLength(2);
    expect(b.records).toHaveLength(1);
    expect(b.settings).not.toBeNull();
  });
});

describe('parseBackup', () => {
  it('导出→解析往返一致', () => {
    const cur = mkCurrent();
    const text = JSON.stringify(buildBackup(cur, 1700000000000));
    const r = parseBackup(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.riddles).toHaveLength(2);
    expect(r.data.records).toHaveLength(1);
    expect(r.data.exportedAt).toBe(1700000000000);
    expect(r.data.settings?.prizes).toEqual(DEFAULT_SETTINGS.prizes);
  });
  it('非 JSON 报错', () => {
    const r = parseBackup('not json{');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('JSON');
  });
  it('kind 不符报错', () => {
    const r = parseBackup(JSON.stringify({ kind: 'other', riddles: [], records: [] }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('kind');
  });
  it('版本过新报错', () => {
    const r = parseBackup(JSON.stringify({ kind: BACKUP_KIND, version: 99, riddles: [], records: [] }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('版本');
  });
  it('缺少谜库/登记数组报错', () => {
    expect(parseBackup(JSON.stringify({ kind: BACKUP_KIND, version: 1, records: [] })).ok).toBe(false);
    expect(parseBackup(JSON.stringify({ kind: BACKUP_KIND, version: 1, riddles: [] })).ok).toBe(false);
  });
  it('谜条缺关键字段时报第几条', () => {
    const r = parseBackup(JSON.stringify({
      kind: BACKUP_KIND, version: 1,
      riddles: [{ id: 'x', surface: '有面无底' }],
      records: [],
    }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('第 1 条');
    expect(r.error).toContain('谜底');
  });
  it('容错规范化：非法枚举回退默认、缺失校验结果给存疑', () => {
    const r = parseBackup(JSON.stringify({
      kind: BACKUP_KIND, version: 1,
      riddles: [{
        id: 'x', no: 5, surface: '谜', answer: '底',
        category: '不存在', format: '也不存在', difficulty: 9, tags: '非数组',
      }],
      records: [{ id: 'r', riddleId: 'x' }],
    }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rid = r.data.riddles[0];
    expect(rid.category).toBe('other');
    expect(rid.format).toBe('none');
    expect(rid.difficulty).toBe(2);
    expect(rid.tags).toEqual([]);
    expect(rid.check.verdict).toBe('suspect');
    expect(r.data.records[0].prize).toBe('');
  });
});

describe('previewBackup / mergeBackup', () => {
  it('全新 id 计新增，同 id 计覆盖', () => {
    const cur = mkCurrent();
    const data = mkBackup({ riddles: [mkRiddle('a', 1, '改后的谜面'), mkRiddle('c', 3)] });
    const p = previewBackup(data, cur, DEFAULT_SETTINGS);
    expect(p.riddlesAdded).toBe(1);
    expect(p.riddlesOverwritten).toBe(1);
    expect(p.renumbered).toBe(0);
    const m = mergeBackup(data, cur, DEFAULT_SETTINGS);
    expect(m.riddles.find((r) => r.id === 'a')?.surface).toBe('改后的谜面');
    expect(m.riddles).toHaveLength(3);
  });
  it('新增谜条谜号冲突时重新编号（取空闲谜号）', () => {
    const cur = mkCurrent(); // 已有 no 1、2
    const data = mkBackup({ riddles: [mkRiddle('c', 2), mkRiddle('d', 2), mkRiddle('e', 0)] });
    const p = previewBackup(data, cur, DEFAULT_SETTINGS);
    expect(p.riddlesAdded).toBe(3);
    expect(p.renumbered).toBe(3);
    const m = mergeBackup(data, cur, DEFAULT_SETTINGS);
    const nos = m.riddles.map((r) => r.no);
    expect(new Set(nos).size).toBe(nos.length); // 无撞号
    expect(Math.max(...nos)).toBe(5);
  });
  it('覆盖时谜号被他人占用则沿用原谜号', () => {
    const cur = mkCurrent(); // a=1, b=2
    const data = mkBackup({ riddles: [mkRiddle('a', 2)] }); // a 想占 b 的 2 号
    const m = mergeBackup(data, cur, DEFAULT_SETTINGS);
    expect(m.riddles.find((r) => r.id === 'a')?.no).toBe(1);
    expect(m.riddles.find((r) => r.id === 'b')?.no).toBe(2);
  });
  it('登记记录按 id 新增/覆盖', () => {
    const cur = mkCurrent();
    const data = mkBackup({
      records: [mkRecord('r1', 'a', 200), mkRecord('r9', 'b', 300)],
    });
    const p = previewBackup(data, cur, DEFAULT_SETTINGS);
    expect(p.recordsAdded).toBe(1);
    expect(p.recordsOverwritten).toBe(1);
    const m = mergeBackup(data, cur, DEFAULT_SETTINGS);
    expect(m.records).toHaveLength(2);
    expect(m.records[0].at).toBe(300); // 按时间倒序
  });
  it('文件内重复 id 只计一次（后者覆盖前者）', () => {
    const cur = mkCurrent({ riddles: [], records: [] });
    const data = mkBackup({ riddles: [mkRiddle('x', 1, '先'), mkRiddle('x', 1, '后')] });
    const p = previewBackup(data, cur, DEFAULT_SETTINGS);
    expect(p.riddlesAdded + p.riddlesOverwritten).toBe(2); // 先新增后覆盖
    const m = mergeBackup(data, cur, DEFAULT_SETTINGS);
    expect(m.riddles).toHaveLength(1);
    expect(m.riddles[0].surface).toBe('后');
  });
  it('设置：文件含设置则覆盖合并默认值，不含则保留当前', () => {
    const cur = mkCurrent();
    const withSettings = mkBackup({
      settings: {
        event: { id: 'e1', title: '新灯会', host: '社区', date: '2026-02-12', riddleIds: [] },
        print: { cardWmm: 80, cardHmm: 150, perPage: 8, showAnswerSlip: false, showCutLine: true, hostLine: '社区' },
        prizes: ['大奖'],
      },
    });
    const p1 = previewBackup(withSettings, cur, DEFAULT_SETTINGS);
    expect(p1.hasSettings).toBe(true);
    const m1 = mergeBackup(withSettings, cur, DEFAULT_SETTINGS);
    expect(m1.settings.event.title).toBe('新灯会');
    expect(m1.settings.print.cardWmm).toBe(80);
    expect(m1.settings.prizes).toEqual(['大奖']);
    const m2 = mergeBackup(mkBackup({ settings: null }), cur, DEFAULT_SETTINGS);
    expect(m2.settings).toBe(cur.settings);
    expect(m2.result.settingsApplied).toBe(false);
  });
  it('预览元信息：导出时间、来源、文件条数', () => {
    const p = previewBackup(mkBackup(), mkCurrent(), DEFAULT_SETTINGS);
    expect(p.exportedAt).toBe(1700000000000);
    expect(p.source).toBe('测试灯会 · 本机');
    expect(p.fileCounts).toEqual({ riddles: 1, records: 1 });
  });
  it('合并不修改原数据（纯函数）', () => {
    const cur = mkCurrent();
    const before = JSON.stringify(cur);
    mergeBackup(mkBackup(), cur, DEFAULT_SETTINGS);
    expect(JSON.stringify(cur)).toBe(before);
  });
});

describe('store.importBackup（无 IndexedDB，内存降级）', () => {
  it('导入后状态更新，persist 标记 memory 并要求先备份再登记', async () => {
    const { store } = await import('../src/lib/store');
    await store.init();
    const before = store.getState().riddles.length;
    const data = mkBackup({ riddles: [mkRiddle('s1', 1)], records: [mkRecord('sr1', 's1')] });
    const r = await store.importBackup(data);
    expect(r.riddlesAdded).toBe(1);
    expect(r.recordsAdded).toBe(1);
    expect(store.getState().riddles.length).toBe(before + 1);
    expect(store.getState().records.some((x) => x.id === 'sr1')).toBe(true);
    // 内存模式：核对后标记 memory，未备份前 needsBackup
    expect(store.getState().persist.mode).toBe('memory');
    expect(store.needsBackup()).toBe(true);
    store.markBackupExported();
    expect(store.needsBackup()).toBe(false);
  });
});
