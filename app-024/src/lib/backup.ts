// 整包备份：谜库 + 登记记录 + 设置 → 单个 JSON 文件
// 文件头写明导出时间、条数与来源；导入先预览（新增/覆盖），确认后写库，失败回滚
import type { AppSettings, OnsiteRecord, Riddle } from '../types';

export const BACKUP_KIND = 'lantern-riddle-backup';
export const BACKUP_VERSION = 1;
export const BACKUP_APP = 'app-024-lantern-riddle-bank';

export interface BackupData {
  kind: typeof BACKUP_KIND;
  app: string;
  version: number;
  exportedAt: number;  // 导出时间（毫秒时间戳，0 = 未知）
  source: string;      // 来源（活动名 · 站点）
  counts: { riddles: number; records: number };
  settings: AppSettings | null; // 老文件可能不含设置
  riddles: Riddle[];
  records: OnsiteRecord[];
}

export interface BackupApplyResult {
  riddlesAdded: number;
  riddlesOverwritten: number;
  renumbered: number; // 新增谜条中谜号冲突被重新编号的条数
  recordsAdded: number;
  recordsOverwritten: number;
  settingsApplied: boolean;
}

export interface BackupPreview extends BackupApplyResult {
  exportedAt: number;
  source: string;
  fileCounts: { riddles: number; records: number };
  hasSettings: boolean;
}

export interface BackupCurrent {
  riddles: Riddle[];
  records: OnsiteRecord[];
  settings: AppSettings;
}

/** 打包当前数据（source 形如「元宵灯会 · localhost:8104」） */
export function buildBackup(state: BackupCurrent, now = Date.now()): BackupData {
  const where = typeof location !== 'undefined' && location.host ? location.host : '本机';
  const title = state.settings.event.title || '未命名活动';
  return {
    kind: BACKUP_KIND,
    app: BACKUP_APP,
    version: BACKUP_VERSION,
    exportedAt: now,
    source: `${title} · ${where}`,
    counts: { riddles: state.riddles.length, records: state.records.length },
    settings: state.settings,
    riddles: state.riddles,
    records: state.records,
  };
}

// ---- 解析（容错规范化：字段缺失给默认值，结构错误给出中文原因）----

const CATEGORIES = new Set(['char', 'object', 'idiom', 'place', 'person', 'other']);
const FORMATS = new Set(['none', 'qiqian', 'juanlian', 'xufei', 'lihua', 'baitou', 'fendi', 'shanglou', 'xialou']);
const VERDICTS = new Set(['pass', 'suspect', 'fail']);
const AGES = new Set(['child', 'teen', 'adult', 'all']);

function asStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

function normRiddle(v: unknown): Riddle | string {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return '不是有效的谜条对象';
  const r = v as Record<string, unknown>;
  if (typeof r.id !== 'string' || !r.id) return '缺少 id';
  if (typeof r.surface !== 'string' || !r.surface.trim()) return '谜面缺失';
  if (typeof r.answer !== 'string' || !r.answer.trim()) return '谜底缺失';
  const no = typeof r.no === 'number' && Number.isFinite(r.no) ? Math.round(r.no) : 0;
  const checkRaw = (r.check ?? {}) as Record<string, unknown>;
  const verdict = VERDICTS.has(checkRaw.verdict as string) ? checkRaw.verdict as Riddle['check']['verdict'] : null;
  return {
    id: r.id,
    no,
    surface: r.surface,
    answer: r.answer,
    category: CATEGORIES.has(r.category as string) ? r.category as Riddle['category'] : 'other',
    format: FORMATS.has(r.format as string) ? r.format as Riddle['format'] : 'none',
    formatNote: asStr(r.formatNote),
    author: asStr(r.author),
    source: asStr(r.source),
    difficulty: r.difficulty === 1 || r.difficulty === 2 || r.difficulty === 3 ? r.difficulty : 2,
    ageGroup: AGES.has(r.ageGroup as string) ? r.ageGroup as Riddle['ageGroup'] : undefined,
    tags: Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === 'string' && !!t.trim()) : [],
    note: asStr(r.note),
    check: verdict
      ? {
          verdict,
          reasons: Array.isArray(checkRaw.reasons) ? checkRaw.reasons.filter((x): x is string => typeof x === 'string') : [],
          checkedAt: typeof checkRaw.checkedAt === 'number' ? checkRaw.checkedAt : 0,
        }
      : { verdict: 'suspect', reasons: ['备份中缺少校验结果，建议恢复后重新校验'], checkedAt: 0 },
  };
}

function normRecord(v: unknown): OnsiteRecord | string {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return '不是有效的登记对象';
  const r = v as Record<string, unknown>;
  if (typeof r.id !== 'string' || !r.id) return '缺少 id';
  if (typeof r.riddleId !== 'string' || !r.riddleId) return '缺少 riddleId';
  return {
    id: r.id,
    riddleId: r.riddleId,
    winnerName: asStr(r.winnerName),
    winnerRef: asStr(r.winnerRef),
    prize: typeof r.prize === 'string' ? r.prize : '',
    at: typeof r.at === 'number' && Number.isFinite(r.at) ? r.at : 0,
    note: asStr(r.note),
    code: asStr(r.code),
  };
}

function normSettings(v: unknown): AppSettings | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const s = v as Record<string, unknown>;
  const ev = (s.event ?? {}) as Record<string, unknown>;
  const pr = (s.print ?? {}) as Record<string, unknown>;
  const num = (x: unknown, d: number) => (typeof x === 'number' && Number.isFinite(x) ? x : d);
  const str = (x: unknown) => (typeof x === 'string' ? x : '');
  return {
    event: {
      id: str(ev.id) || 'event-default',
      title: str(ev.title),
      host: str(ev.host),
      date: str(ev.date),
      riddleIds: Array.isArray(ev.riddleIds) ? ev.riddleIds.filter((x): x is string => typeof x === 'string') : [],
    },
    print: {
      cardWmm: num(pr.cardWmm, 63),
      cardHmm: num(pr.cardHmm, 135),
      perPage: num(pr.perPage, 6),
      showAnswerSlip: typeof pr.showAnswerSlip === 'boolean' ? pr.showAnswerSlip : true,
      showCutLine: typeof pr.showCutLine === 'boolean' ? pr.showCutLine : true,
      hostLine: str(pr.hostLine),
    },
    prizes: Array.isArray(s.prizes) ? s.prizes.filter((x): x is string => typeof x === 'string' && !!x.trim()) : [],
  };
}

export type ParseBackupResult = { ok: true; data: BackupData } | { ok: false; error: string };

/** 解析备份文件文本；结构不合法时返回中文错误原因 */
export function parseBackup(text: string): ParseBackupResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: '文件不是有效的 JSON' };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: '文件内容不是备份对象' };
  const o = raw as Record<string, unknown>;
  if (o.kind !== BACKUP_KIND) return { ok: false, error: '不是本应用的整包备份文件（kind 标识不符）' };
  if (typeof o.version !== 'number' || o.version > BACKUP_VERSION) {
    return { ok: false, error: `备份版本过新（${String(o.version)}），当前应用支持 ≤ ${BACKUP_VERSION}` };
  }
  if (!Array.isArray(o.riddles)) return { ok: false, error: '备份文件缺少谜库数据（riddles）' };
  if (!Array.isArray(o.records)) return { ok: false, error: '备份文件缺少登记记录（records）' };

  const riddles: Riddle[] = [];
  for (let i = 0; i < o.riddles.length; i++) {
    const r = normRiddle(o.riddles[i]);
    if (typeof r === 'string') return { ok: false, error: `谜库第 ${i + 1} 条：${r}` };
    riddles.push(r);
  }
  const records: OnsiteRecord[] = [];
  for (let i = 0; i < o.records.length; i++) {
    const r = normRecord(o.records[i]);
    if (typeof r === 'string') return { ok: false, error: `登记记录第 ${i + 1} 条：${r}` };
    records.push(r);
  }
  const countsRaw = o.counts as Record<string, unknown> | undefined;
  return {
    ok: true,
    data: {
      kind: BACKUP_KIND,
      app: typeof o.app === 'string' ? o.app : BACKUP_APP,
      version: o.version,
      exportedAt: typeof o.exportedAt === 'number' && Number.isFinite(o.exportedAt) ? o.exportedAt : 0,
      source: typeof o.source === 'string' && o.source ? o.source : '未知来源',
      counts: {
        riddles: typeof countsRaw?.riddles === 'number' ? countsRaw.riddles : riddles.length,
        records: typeof countsRaw?.records === 'number' ? countsRaw.records : records.length,
      },
      settings: normSettings(o.settings),
      riddles,
      records,
    },
  };
}

// ---- 合并与预览 ----

/**
 * 合并备份到当前数据（纯函数，不改库）：
 * 同 id 覆盖；新 id 追加，谜号冲突或缺失时重新编号（取空闲谜号）；设置整包覆盖
 */
export function mergeBackup(
  data: BackupData,
  current: BackupCurrent,
  defaults: AppSettings,
): { riddles: Riddle[]; records: OnsiteRecord[]; settings: AppSettings; result: BackupApplyResult } {
  const result: BackupApplyResult = {
    riddlesAdded: 0, riddlesOverwritten: 0, renumbered: 0,
    recordsAdded: 0, recordsOverwritten: 0,
    settingsApplied: !!data.settings,
  };

  const byId = new Map(current.riddles.map((r) => [r.id, r]));
  const usedNo = new Set(current.riddles.map((r) => r.no));
  let nextNo = current.riddles.reduce((m, r) => Math.max(m, r.no), 0) + 1;
  for (const r of data.riddles) {
    const exist = byId.get(r.id);
    if (exist) {
      // 覆盖：谜号被其他谜条占用时沿用原谜号，避免撞号
      const no = r.no > 0 && (!usedNo.has(r.no) || exist.no === r.no) ? r.no : exist.no;
      if (no !== exist.no) { usedNo.delete(exist.no); usedNo.add(no); }
      byId.set(r.id, { ...r, no });
      result.riddlesOverwritten++;
    } else {
      let no = r.no;
      if (no <= 0 || usedNo.has(no)) {
        no = Math.max(nextNo, 1);
        while (usedNo.has(no)) no++;
        nextNo = no + 1;
        result.renumbered++;
      }
      usedNo.add(no);
      byId.set(r.id, { ...r, no });
      result.riddlesAdded++;
    }
  }

  const recById = new Map(current.records.map((r) => [r.id, r]));
  for (const rec of data.records) {
    if (recById.has(rec.id)) result.recordsOverwritten++; else result.recordsAdded++;
    recById.set(rec.id, rec);
  }

  const settings: AppSettings = data.settings
    ? {
        event: { ...defaults.event, ...data.settings.event },
        print: { ...defaults.print, ...data.settings.print },
        prizes: data.settings.prizes.length ? data.settings.prizes : defaults.prizes,
      }
    : current.settings;

  return {
    riddles: [...byId.values()].sort((a, b) => a.no - b.no),
    records: [...recById.values()].sort((a, b) => b.at - a.at),
    settings,
    result,
  };
}

/** 导入预览：与 mergeBackup 同一套口径，先让用户看清会新增/覆盖什么 */
export function previewBackup(data: BackupData, current: BackupCurrent, defaults: AppSettings): BackupPreview {
  const { result } = mergeBackup(data, current, defaults);
  return {
    ...result,
    exportedAt: data.exportedAt,
    source: data.source,
    fileCounts: { riddles: data.riddles.length, records: data.records.length },
    hasSettings: !!data.settings,
  };
}
