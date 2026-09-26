// 整包备份/恢复：导出格式、解析校验、导入预览计划、合并（纯函数，便于测试）
// 备份文件为 JSON：写明导出时间、条数与来源；导入按 id 合并（新增/覆盖），谜号冲突自动重排
import type { AppSettings, OnsiteRecord, Riddle } from '../types';

export const BACKUP_KIND = 'lantern-riddle-backup';
export const BACKUP_VERSION = 1;
export const BACKUP_APP = 'app-024-lantern-riddle-bank';

export interface BackupFile {
  kind: typeof BACKUP_KIND;
  app: string;                                 // 来源应用标识
  version: number;
  exportedAt: string;                          // 导出时间（ISO）
  counts: { riddles: number; records: number }; // 导出时条数
  source: { event: string; host: string; storage: string }; // 来源活动与存储方式
  dataInvalidSkipped?: number;               // 解析时跳过的无效条数
  data: {
    riddles: Riddle[];
    records: OnsiteRecord[];
    settings: AppSettings;
  };
}

/** 组装整包备份（谜库 + 登记记录 + 设置） */
export function buildBackup(
  riddles: Riddle[],
  records: OnsiteRecord[],
  settings: AppSettings,
  storage: string,
  now = new Date(),
): BackupFile {
  return {
    kind: BACKUP_KIND,
    app: BACKUP_APP,
    version: BACKUP_VERSION,
    exportedAt: now.toISOString(),
    counts: { riddles: riddles.length, records: records.length },
    source: { event: settings.event.title, host: settings.event.host, storage },
    data: { riddles, records, settings },
  };
}

export type ParseResult = { ok: true; backup: BackupFile } | { ok: false; error: string };

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 谜条/登记记录的基础字段校验（宽松：只查恢复所必需的键） */
function validRiddle(v: unknown): v is Riddle {
  return isObj(v) && typeof v.id === 'string' && typeof v.no === 'number'
    && typeof v.surface === 'string' && typeof v.answer === 'string';
}
function validRecord(v: unknown): v is OnsiteRecord {
  return isObj(v) && typeof v.id === 'string' && typeof v.riddleId === 'string' && typeof v.at === 'number';
}

/** 解析并校验备份文件；失败给出可读原因 */
export function parseBackup(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: '文件不是有效的 JSON，请选择本应用导出的整包备份文件' };
  }
  if (!isObj(raw)) return { ok: false, error: '备份文件内容不是对象' };
  if (raw.kind !== BACKUP_KIND) return { ok: false, error: '不是本应用的整包备份文件（kind 不符）' };
  const version = typeof raw.version === 'number' ? raw.version : 0;
  if (version > BACKUP_VERSION) {
    return { ok: false, error: `备份文件版本过新（v${version} > v${BACKUP_VERSION}），请升级应用后再导入` };
  }
  const data = raw.data;
  if (!isObj(data) || !Array.isArray(data.riddles) || !Array.isArray(data.records) || !isObj(data.settings)) {
    return { ok: false, error: '备份文件缺少谜库 / 登记 / 设置数据，文件可能已损坏' };
  }
  const riddles = (data.riddles as unknown[]).filter(validRiddle);
  const records = (data.records as unknown[]).filter(validRecord);
  const skipped = data.riddles.length - riddles.length + (data.records.length - records.length);
  const settings = data.settings as AppSettings;
  const backup: BackupFile = {
    kind: BACKUP_KIND,
    app: typeof raw.app === 'string' ? raw.app : BACKUP_APP,
    version,
    exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : '',
    counts: isObj(raw.counts) && typeof raw.counts.riddles === 'number' && typeof raw.counts.records === 'number'
      ? { riddles: raw.counts.riddles, records: raw.counts.records }
      : { riddles: riddles.length, records: records.length },
    source: isObj(raw.source)
      ? {
        event: typeof raw.source.event === 'string' ? raw.source.event : '',
        host: typeof raw.source.host === 'string' ? raw.source.host : '',
        storage: typeof raw.source.storage === 'string' ? raw.source.storage : '',
      }
      : { event: '', host: '', storage: '' },
    data: { riddles, records, settings },
  };
  if (skipped > 0) backup.dataInvalidSkipped = skipped;
  return { ok: true, backup };
}

export interface ImportPlan {
  backup: BackupFile;
  freshRiddles: Riddle[];      // 将新增的谜条
  overwriteRiddles: Riddle[];  // 将覆盖的谜条（同 id）
  freshRecords: OnsiteRecord[];
  overwriteRecords: OnsiteRecord[];
  settings: AppSettings;       // 设置整体替换
  renumbered: number;          // 因谜号冲突被重新编号的条数
  orphanRecords: number;       // 登记记录指向的谜条在合并后仍不存在的条数
}

/**
 * 生成导入预览计划：按 id 匹配合并。
 * 谜号冲突（新增/覆盖项的 no 已被保留项占用）时自动分配到空闲谜号。
 */
export function planImport(backup: BackupFile, curRiddles: Riddle[], curRecords: OnsiteRecord[]): ImportPlan {
  const curRiddleIds = new Set(curRiddles.map((r) => r.id));
  const curRecordIds = new Set(curRecords.map((r) => r.id));

  const overwriteRiddles = backup.data.riddles.filter((r) => curRiddleIds.has(r.id));
  const freshRiddles = backup.data.riddles.filter((r) => !curRiddleIds.has(r.id));
  const overwriteRecords = backup.data.records.filter((r) => curRecordIds.has(r.id));
  const freshRecords = backup.data.records.filter((r) => !curRecordIds.has(r.id));

  // 现有库中「不被覆盖」的条目占用的谜号不可再分配
  const overwriteIds = new Set(overwriteRiddles.map((r) => r.id));
  const used = new Set(curRiddles.filter((r) => !overwriteIds.has(r.id)).map((r) => r.no));
  let nextNo = Math.max(0, ...curRiddles.map((r) => r.no), ...backup.data.riddles.map((r) => r.no)) + 1;
  const alloc = (): number => {
    while (used.has(nextNo)) nextNo++;
    const n = nextNo++;
    used.add(n);
    return n;
  };
  let renumbered = 0;
  const place = (list: Riddle[]): Riddle[] => list.map((r) => {
    if (used.has(r.no)) {
      renumbered++;
      return { ...r, no: alloc() };
    }
    used.add(r.no);
    return r;
  });

  const plan: ImportPlan = {
    backup,
    freshRiddles: place(freshRiddles),
    overwriteRiddles: place(overwriteRiddles),
    freshRecords,
    overwriteRecords,
    settings: backup.data.settings,
    renumbered,
    orphanRecords: 0,
  };
  const mergedIds = new Set([...curRiddles.map((r) => r.id), ...backup.data.riddles.map((r) => r.id)]);
  plan.orphanRecords = [...freshRecords, ...overwriteRecords].filter((r) => !mergedIds.has(r.riddleId)).length;
  return plan;
}

/** 合并谜库：覆盖同 id 项 + 追加新增项，按谜号排序 */
export function mergeRiddles(cur: Riddle[], plan: ImportPlan): Riddle[] {
  const ow = new Map(plan.overwriteRiddles.map((r) => [r.id, r]));
  return cur.map((r) => ow.get(r.id) ?? r).concat(plan.freshRiddles).sort((a, b) => a.no - b.no);
}

/** 合并登记记录：覆盖同 id 项 + 追加新增项，按时间倒序 */
export function mergeRecords(cur: OnsiteRecord[], plan: ImportPlan): OnsiteRecord[] {
  const ow = new Map(plan.overwriteRecords.map((r) => [r.id, r]));
  return cur.map((r) => ow.get(r.id) ?? r).concat(plan.freshRecords).sort((a, b) => b.at - a.at);
}

/** 采用备份设置，并把活动清单里已不存在的谜条 id 过滤掉 */
export function mergeSettings(plan: ImportPlan, mergedRiddles: Riddle[], fallback: AppSettings): AppSettings {
  const s = plan.settings;
  const ids = new Set(mergedRiddles.map((r) => r.id));
  return {
    event: {
      ...fallback.event,
      ...(s.event ?? {}),
      riddleIds: (s.event?.riddleIds ?? []).filter((id) => ids.has(id)),
    },
    print: { ...fallback.print, ...(s.print ?? {}) },
    prizes: Array.isArray(s.prizes) && s.prizes.length ? s.prizes : fallback.prizes,
  };
}
