// 集中式应用状态：数据读写全部在此，UI 只做展示与动作调用
import type { AppSettings, OnsiteRecord, Riddle } from '../types';
import { validateRiddle } from './validate';
import { EMPTY_CTX, loadDataCtx, type DataCtx } from './datafiles';
import * as idb from './idb';
import { formatDate, downloadText } from './format';
import { buildBackup, mergeBackup, type BackupApplyResult, type BackupData } from './backup';

const KV_SETTINGS = 'settings';

export const DEFAULT_SETTINGS: AppSettings = {
  event: { id: 'event-default', title: '元宵灯会', host: '', date: '', riddleIds: [] },
  print: {
    cardWmm: 63, cardHmm: 135, perPage: 6,
    showAnswerSlip: true, showCutLine: true,
    hostLine: '',
  },
  prizes: ['参与奖', '三等奖', '二等奖', '一等奖'],
};

/** 持久化状态：每次写入后核对实际落库条数，对不上即 degraded */
export interface PersistStatus {
  mode: 'persistent' | 'memory' | 'degraded';
  detail?: string;
  since: number; // 首次发现时间（会话级），用于判断备份是否已覆盖本次风险
}

export interface AppState {
  ready: boolean;
  riddles: Riddle[];
  records: OnsiteRecord[];
  settings: AppSettings;
  ctx: DataCtx; // 拼音/部件离线数据
  selected: Set<string>; // 批量出条选中（会话级，不持久化）
  persist: PersistStatus;
  backupAt: number | null; // 本次会话最近一次整包导出时间（会话级，不持久化）
}

type Listener = () => void;

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

class AppStore {
  private state: AppState = {
    ready: false,
    riddles: [],
    records: [],
    settings: DEFAULT_SETTINGS,
    ctx: EMPTY_CTX,
    selected: new Set<string>(),
    persist: { mode: 'persistent', since: 0 },
    backupAt: null,
  };
  private listeners = new Set<Listener>();
  private initPromise: Promise<void> | null = null;

  getState = (): AppState => this.state;

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private emit() {
    this.state = { ...this.state };
    for (const l of this.listeners) l();
  }

  init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        const [riddles, records, settings, ctx] = await Promise.all([
          idb.getAll<Riddle>(idb.STORE_RIDDLES),
          idb.getAll<OnsiteRecord>(idb.STORE_RECORDS),
          idb.getKV<AppSettings>(KV_SETTINGS),
          loadDataCtx(import.meta.env.BASE_URL),
        ]);
        this.state.riddles = riddles.sort((a, b) => a.no - b.no);
        this.state.records = records.sort((a, b) => b.at - a.at);
        if (settings) {
          this.state.settings = {
            event: { ...DEFAULT_SETTINGS.event, ...settings.event },
            print: { ...DEFAULT_SETTINGS.print, ...settings.print },
            prizes: settings.prizes?.length ? settings.prizes : DEFAULT_SETTINGS.prizes,
          };
        }
        if (!this.state.settings.print.hostLine && this.state.settings.event.host) {
          this.state.settings.print.hostLine = `${this.state.settings.event.host}`;
        }
        this.state.ctx = ctx;
        this.state.ready = true;
        await this.verifyPersist();
        this.emit();
      })();
    }
    return this.initPromise;
  }

  // ---- 持久化核对 ----
  private setPersist(mode: PersistStatus['mode'], detail?: string): void {
    if (mode === 'persistent') {
      this.state.persist = { mode, since: 0 };
      return;
    }
    const cur = this.state.persist;
    // 同类问题保持首次发现时间，便于判断「备份是否已覆盖本次风险」
    const since = cur.mode === mode && cur.since ? cur.since : Date.now();
    this.state.persist = { mode, detail, since };
  }

  /** 每次写入后核对实际落库条数；内存模式或条数对不上时置为异常 */
  private async verifyPersist(): Promise<void> {
    if (idb.backend() === 'memory') {
      this.setPersist('memory', '当前环境没有可用的本机数据库（IndexedDB），数据仅保存在内存中');
      return;
    }
    const [rn, cn] = await Promise.all([idb.count(idb.STORE_RIDDLES), idb.count(idb.STORE_RECORDS)]);
    const parts: string[] = [];
    if (rn == null || cn == null) {
      parts.push('无法读取本机数据库核对条数');
    } else {
      if (rn !== this.state.riddles.length) parts.push(`谜库应有 ${this.state.riddles.length} 条，实际存下 ${rn} 条`);
      if (cn !== this.state.records.length) parts.push(`登记应有 ${this.state.records.length} 条，实际存下 ${cn} 条`);
    }
    const werr = idb.lastError();
    if (parts.length) this.setPersist('degraded', parts.join('；'));
    else if (werr) this.setPersist('degraded', werr);
    else this.setPersist('persistent');
  }

  /** 存储异常且尚未导出备份（或备份早于异常发现时间）时，要求先备份再登记 */
  needsBackup(): boolean {
    const p = this.state.persist;
    if (p.mode === 'persistent') return false;
    return !this.state.backupAt || this.state.backupAt < p.since;
  }

  markBackupExported(): void {
    this.state.backupAt = Date.now();
    this.emit();
  }

  // ---- 谜库 ----
  nextNo(): number {
    return this.state.riddles.reduce((m, r) => Math.max(m, r.no), 0) + 1;
  }

  /** 新增/保存：自动计算谜格校验结果 */
  async saveRiddle(patch: Omit<Riddle, 'id' | 'no' | 'check'> & { id?: string; no?: number }): Promise<Riddle> {
    const id = patch.id ?? uid();
    const existing = patch.id ? this.state.riddles.find((r) => r.id === patch.id) : undefined;
    const no = patch.no ?? existing?.no ?? this.nextNo();
    const check = validateRiddle(patch, this.state.ctx);
    const riddle: Riddle = {
      ...patch,
      id,
      no,
      check: { ...check, checkedAt: Date.now() },
      tags: patch.tags ?? [],
      difficulty: patch.difficulty ?? 2,
    };
    if (existing) {
      this.state.riddles = this.state.riddles.map((r) => (r.id === id ? riddle : r));
    } else {
      this.state.riddles = [...this.state.riddles, riddle];
    }
    this.state.riddles.sort((a, b) => a.no - b.no);
    await idb.put(idb.STORE_RIDDLES, riddle);
    await this.verifyPersist();
    this.emit();
    return riddle;
  }

  /** 批量导入（去重后的新增项） */
  async addRiddles(items: (Omit<Riddle, 'id' | 'no' | 'check'> & Partial<Pick<Riddle, 'no'>>)[]): Promise<number> {
    if (!items.length) return 0;
    let no = this.nextNo();
    const now = Date.now();
    const riddles: Riddle[] = items.map((it) => ({
      ...it,
      id: uid(),
      no: it.no ?? no++,
      tags: it.tags ?? [],
      difficulty: it.difficulty ?? 2,
      check: { ...validateRiddle(it, this.state.ctx), checkedAt: now },
    }));
    this.state.riddles = [...this.state.riddles, ...riddles].sort((a, b) => a.no - b.no);
    await idb.putMany(idb.STORE_RIDDLES, riddles);
    await this.verifyPersist();
    this.emit();
    return riddles.length;
  }

  async recheckAll(): Promise<void> {
    const now = Date.now();
    const riddles = this.state.riddles.map((r) => ({
      ...r,
      check: { ...validateRiddle(r, this.state.ctx), checkedAt: now },
    }));
    this.state.riddles = riddles.sort((a, b) => a.no - b.no);
    await idb.putMany(idb.STORE_RIDDLES, riddles);
    await this.verifyPersist();
    this.emit();
  }

  async removeRiddles(ids: string[]): Promise<void> {
    const set = new Set(ids);
    this.state.riddles = this.state.riddles.filter((r) => !set.has(r.id));
    this.state.settings.event.riddleIds = this.state.settings.event.riddleIds.filter((x) => !set.has(x));
    await Promise.all(ids.map((id) => idb.del(idb.STORE_RIDDLES, id)));
    await this.saveSettings(this.state.settings); // 同步活动清单（saveSettings 内已核对）
    this.emit();
  }

  async clearRiddles(): Promise<void> {
    this.state.riddles = [];
    this.state.settings.event.riddleIds = [];
    await idb.clearStore(idb.STORE_RIDDLES);
    await this.saveSettings(this.state.settings);
    this.emit();
  }

  async loadSample(samples: Omit<Riddle, 'id' | 'no' | 'check'>[]): Promise<number> {
    return this.addRiddles(samples);
  }

  // ---- 批量选中（会话级）----
  toggleSelect(id: string): void {
    const s = new Set(this.state.selected);
    if (s.has(id)) s.delete(id); else s.add(id);
    this.state.selected = s;
    this.emit();
  }

  selectMany(ids: string[], on: boolean): void {
    const s = new Set(this.state.selected);
    for (const id of ids) { if (on) s.add(id); else s.delete(id); }
    this.state.selected = s;
    this.emit();
  }

  clearSelection(): void {
    this.state.selected = new Set();
    this.emit();
  }

  // ---- 现场登记 ----
  recordsOf(riddleId: string): OnsiteRecord[] {
    return this.state.records.filter((r) => r.riddleId === riddleId);
  }

  async addRecord(rec: Omit<OnsiteRecord, 'id' | 'at'> & { at?: number }): Promise<OnsiteRecord> {
    const full: OnsiteRecord = { ...rec, id: uid(), at: rec.at ?? Date.now() };
    this.state.records = [full, ...this.state.records];
    await idb.put(idb.STORE_RECORDS, full);
    await this.verifyPersist();
    this.emit();
    return full;
  }

  async removeRecord(id: string): Promise<void> {
    this.state.records = this.state.records.filter((r) => r.id !== id);
    await idb.del(idb.STORE_RECORDS, id);
    await this.verifyPersist();
    this.emit();
  }

  async clearRecords(): Promise<void> {
    this.state.records = [];
    await idb.clearStore(idb.STORE_RECORDS);
    await this.verifyPersist();
    this.emit();
  }

  /** 兑奖号码生成：按登记时间顺序生成 DJ-xxxx（仅生成号码，不做在线抽奖） */
  async generatePrizeCodes(): Promise<number> {
    let n = 0;
    const sorted = [...this.state.records].sort((a, b) => a.at - b.at);
    for (const r of sorted) {
      if (!r.code) {
        n++;
        r.code = `DJ-${String(n).padStart(4, '0')}`;
        await idb.put(idb.STORE_RECORDS, r);
      }
    }
    if (n) {
      await this.verifyPersist();
      this.emit();
    }
    return n;
  }

  // ---- 设置 ----
  async saveSettings(patch: Partial<AppSettings>): Promise<void> {
    this.state.settings = {
      event: { ...this.state.settings.event, ...patch.event },
      print: { ...this.state.settings.print, ...patch.print },
      prizes: patch.prizes ?? this.state.settings.prizes,
    };
    await idb.setKV(KV_SETTINGS, this.state.settings);
    await this.verifyPersist();
    this.emit();
  }

  // ---- 整包备份 / 恢复 ----
  /**
   * 恢复备份：整表替换写库后核对条数，任何一步失败即回滚到导入前状态并抛错
   */
  async importBackup(data: BackupData): Promise<BackupApplyResult> {
    const before = {
      riddles: this.state.riddles,
      records: this.state.records,
      settings: this.state.settings,
    };
    const merged = mergeBackup(data, before, DEFAULT_SETTINGS);

    const writes = [
      await idb.replaceAll(idb.STORE_RIDDLES, merged.riddles),
      await idb.replaceAll(idb.STORE_RECORDS, merged.records),
      await idb.setKV(KV_SETTINGS, merged.settings),
    ];
    let fail = writes.every(Boolean) ? '' : '写入本机数据库失败';
    if (!fail && idb.backend() !== 'memory') {
      const [rn, cn] = await Promise.all([idb.count(idb.STORE_RIDDLES), idb.count(idb.STORE_RECORDS)]);
      if (rn !== merged.riddles.length || cn !== merged.records.length) {
        fail = `写入后核对不符（谜库存下 ${rn ?? '?'} / ${merged.riddles.length} 条，登记存下 ${cn ?? '?'} / ${merged.records.length} 条）`;
      }
    }
    if (fail) {
      // 回滚到导入前状态
      await idb.replaceAll(idb.STORE_RIDDLES, before.riddles);
      await idb.replaceAll(idb.STORE_RECORDS, before.records);
      await idb.setKV(KV_SETTINGS, before.settings);
      await this.verifyPersist();
      this.emit();
      throw new Error(`${fail}，已回滚到导入前状态`);
    }

    this.state.riddles = merged.riddles;
    this.state.records = merged.records;
    this.state.settings = merged.settings;
    await this.verifyPersist();
    this.emit();
    return merged.result;
  }

  // ---- 统计 ----
  stats(): { total: number; solved: number; remaining: number; prizes: number } {
    const solvedSet = new Set(this.state.records.map((r) => r.riddleId));
    return {
      total: this.state.riddles.length,
      solved: solvedSet.size,
      remaining: this.state.riddles.length - solvedSet.size,
      prizes: this.state.records.filter((r) => r.prize.trim()).length,
    };
  }

  riddleByNo(no: number): Riddle | undefined {
    return this.state.riddles.find((r) => r.no === no);
  }
}

export const store = new AppStore();

// ---- 导出辅助（供各页面/导出模块复用）----
export function exportFileName(prefix: string, ext: string): string {
  const ev = store.getState().settings.event;
  const base = ev.title ? `${ev.title}-` : '';
  return `${prefix}-${base}${formatDate(new Date())}.${ext}`;
}

/** 导出整包备份（谜库+登记+设置，JSON），并记录备份时间用于登记前校验 */
export function downloadFullBackup(): void {
  const data = buildBackup(store.getState());
  downloadText(exportFileName('整包备份', 'json'), JSON.stringify(data, null, 2), 'application/json;charset=utf-8');
  store.markBackupExported();
}
