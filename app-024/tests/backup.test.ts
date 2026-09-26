// 整包备份/恢复：导出格式、解析校验、导入预览计划、合并
import { describe, it, expect } from 'vitest';
import {
  buildBackup, parseBackup, planImport, mergeRiddles, mergeRecords, mergeSettings,
  BACKUP_KIND, BACKUP_APP, type BackupFile,
} from '../src/lib/backup';
import type { AppSettings, OnsiteRecord, Riddle } from '../src/types';
import { DEFAULT_SETTINGS } from '../src/lib/store';

function riddle(id: string, no: number, surface = `谜${no}`): Riddle {
  return {
    id, no, surface, answer: '答', category: 'char', format: 'none',
    difficulty: 2, tags: [], check: { verdict: 'pass', reasons: [], checkedAt: 0 },
  };
}
function record(id: string, riddleId: string, at = 1): OnsiteRecord {
  return { id, riddleId, prize: '参与奖', at };
}
function settings(title = '测试灯会'): AppSettings {
  return JSON.parse(JSON.stringify({ ...DEFAULT_SETTINGS, event: { ...DEFAULT_SETTINGS.event, title } }));
}
function makeBackup(
  riddles: Riddle[], records: OnsiteRecord[], s: AppSettings = settings(), extra: Partial<BackupFile> = {},
): BackupFile {
  return { ...buildBackup(riddles, records, s, 'IndexedDB', new Date(0)), ...extra };
}

describe('buildBackup', () => {
  it('写明导出时间、条数与来源', () => {
    const b = buildBackup([riddle('a', 1)], [record('r1', 'a')], settings('我的灯会'), 'IndexedDB', new Date(0));
    expect(b.kind).toBe(BACKUP_KIND);
    expect(b.app).toBe(BACKUP_APP);
    expect(b.version).toBe(1);
    expect(b.exportedAt).toBe(new Date(0).toISOString());
    expect(b.counts).toEqual({ riddles: 1, records: 1 });
    expect(b.source).toMatchObject({ event: '我的灯会', storage: 'IndexedDB' });
    expect(b.data.riddles).toHaveLength(1);
    expect(b.data.settings.event.title).toBe('我的灯会');
  });
});

describe('parseBackup', () => {
  it('合法文件解析成功', () => {
    const text = JSON.stringify(makeBackup([riddle('a', 1)], [record('r1', 'a')]));
    const r = parseBackup(text);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.backup.data.riddles[0].surface).toBe('谜1');
  });
  it('非 JSON 报错', () => {
    expect(parseBackup('not json{').ok).toBe(false);
  });
  it('kind 不符报错（防止误选 CSV 等其他文件）', () => {
    const bad = JSON.stringify({ kind: 'other', data: {} });
    const r = parseBackup(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('kind');
  });
  it('版本过新报错', () => {
    const b = makeBackup([], []);
    b.version = 999;
    const r = parseBackup(JSON.stringify(b));
    expect(r.ok).toBe(false);
  });
  it('缺 data 报错', () => {
    const b = { kind: BACKUP_KIND, version: 1 };
    expect(parseBackup(JSON.stringify(b)).ok).toBe(false);
  });
  it('无效条目被过滤并计数', () => {
    const b = makeBackup([riddle('a', 1)], [record('r1', 'a')]);
    (b.data.riddles as unknown[]).push({ id: 'bad' }); // 缺 no/surface
    (b.data.records as unknown[]).push({ riddleId: 'x' }); // 缺 id/at
    const r = parseBackup(JSON.stringify(b));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.backup.data.riddles).toHaveLength(1);
      expect(r.backup.data.records).toHaveLength(1);
      expect(r.backup.dataInvalidSkipped).toBe(2);
    }
  });
});

describe('planImport 预览', () => {
  const curRiddles = [riddle('a', 1), riddle('b', 2)];
  const curRecords = [record('r1', 'a')];

  it('按 id 分类新增 / 覆盖', () => {
    const b = makeBackup(
      [riddle('b', 2, '覆盖后的谜面'), riddle('c', 3, '新谜条')],
      [record('r2', 'c'), record('r1', 'a', 9)],
    );
    const p = planImport(b, curRiddles, curRecords);
    expect(p.freshRiddles.map((x) => x.id)).toEqual(['c']);
    expect(p.overwriteRiddles.map((x) => x.id)).toEqual(['b']);
    expect(p.overwriteRiddles[0].surface).toBe('覆盖后的谜面');
    expect(p.freshRecords.map((x) => x.id)).toEqual(['r2']);
    expect(p.overwriteRecords.map((x) => x.id)).toEqual(['r1']);
    expect(p.renumbered).toBe(0);
  });

  it('谜号冲突（与保留项）自动重新编号', () => {
    // 备份谜条 d 想用 no=1，但 no=1 的现有谜条 a 不在备份里（保留），d 必须改号
    const b = makeBackup([riddle('d', 1, '外来谜')], []);
    const p = planImport(b, curRiddles, []);
    expect(p.freshRiddles[0].id).toBe('d');
    expect(p.freshRiddles[0].no).toBe(3);
    expect(p.renumbered).toBe(1);
  });

  it('覆盖项沿用原谜号不判冲突', () => {
    const b = makeBackup([riddle('a', 1, '新面')], []);
    const p = planImport(b, curRiddles, []);
    expect(p.overwriteRiddles[0].no).toBe(1);
    expect(p.renumbered).toBe(0);
  });

  it('备份内部谜号重复时第二个被改号', () => {
    const b = makeBackup([riddle('e', 5, 'E'), riddle('f', 5, 'F')], []);
    const p = planImport(b, curRiddles, []);
    const nos = p.freshRiddles.map((x) => x.no).sort();
    expect(new Set(nos).size).toBe(2);
    expect(p.renumbered).toBe(1);
  });

  it('统计找不到对应谜条的登记记录', () => {
    const b = makeBackup([], [record('rx', 'ghost')]);
    const p = planImport(b, curRiddles, []);
    expect(p.orphanRecords).toBe(1);
  });
});

describe('merge* 合并', () => {
  it('mergeRiddles：覆盖同 id + 追加新增 + 按谜号排序', () => {
    const cur = [riddle('a', 1), riddle('b', 2)];
    const b = makeBackup([riddle('b', 2, '改'), riddle('c', 4, '新')], []);
    const p = planImport(b, cur, []);
    const merged = mergeRiddles(cur, p);
    expect(merged.map((x) => x.id)).toEqual(['a', 'b', 'c']);
    expect(merged[1].surface).toBe('改');
  });

  it('mergeRecords：覆盖同 id + 追加新增 + 按时间倒序', () => {
    const cur = [record('r1', 'a', 5)];
    const b = makeBackup([], [record('r1', 'a', 10), record('r2', 'b', 8)]);
    const p = planImport(b, [], cur);
    const merged = mergeRecords(cur, p);
    expect(merged.map((x) => x.id)).toEqual(['r1', 'r2']);
    expect(merged[0].at).toBe(10);
  });

  it('mergeSettings：整体替换，活动清单过滤掉不存在的谜条 id', () => {
    const s = settings('外来灯会');
    s.event.riddleIds = ['a', 'ghost'];
    const b = makeBackup([riddle('a', 1)], [], s);
    const mergedRiddles = [riddle('a', 1)];
    const p = planImport(b, [], []);
    const out = mergeSettings(p, mergedRiddles, DEFAULT_SETTINGS);
    expect(out.event.title).toBe('外来灯会');
    expect(out.event.riddleIds).toEqual(['a']);
  });

  it('备份缺打印/奖品时回退默认', () => {
    const b = makeBackup([], [], settings());
    delete (b.data.settings as Partial<AppSettings>).print;
    b.data.settings.prizes = [];
    const r = parseBackup(JSON.stringify(b));
    expect(r.ok).toBe(true);
    if (r.ok) {
      const p = planImport(r.backup, [], []);
      const out = mergeSettings(p, [], DEFAULT_SETTINGS);
      expect(out.print).toEqual(DEFAULT_SETTINGS.print);
      expect(out.prizes).toEqual(DEFAULT_SETTINGS.prizes);
    }
  });
});
