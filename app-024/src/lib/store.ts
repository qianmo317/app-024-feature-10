// 集中式应用状态：数据读写全部在此，UI 只做展示与动作调用
import type { AppSettings, OnsiteRecord, Riddle } from '../types';
import { validateRiddle } from './validate';
import { EMPTY_CTX, loadDataCtx, type DataCtx } from './datafiles';
import * as idb from './idb';
import { formatDate, downloadText } from './format';
import { buildBackup, mergeRiddles, mergeRecords, mergeSettings, type ImportPlan } from './backup';

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

/** 持久化核对结果：内存降级 / 写入条数对不上 时给出醒目提示 */
export interface PersistIssue {
  kind: 'memory' | 'mismatch';
  message: string;
  expected?: { riddles: number; records: number };
  actual?: { riddles: number; records: number };
  at: number;
}

export interface AppState {
  ready: boolean;
  riddles: Riddle[];
  records: OnsiteRecord[];
  settings: AppSettings;
  ctx: DataCtx; // 拼音/部件离线数据
  selected: Set<string>; // 批量出条选中（会话级，不持久化）
  storageMode: 'idb' | 'mem'; // 本机数据库可用性（mem = 刷新即丢失）
  persistIssue: PersistIssue | null; // 最近一次写入核对结果
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
    storageMode: 'idb',
    persistIssue: null,
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

  /**
   * 写入后核对：对比内存预期条数与实际落库条数。
   * 内存降级模式直接标记 issue（数据根本没存住）；条数对不上说明有写入没落盘。
   */
  private async verifyPersist(): Promise<void> {
    if (this.state.storageMode === 'mem') {
      this.state.persistIssue = {
        kind: 'memory',
        message: '当前环境无法使用本机数据库，数据只保存在内存中，页面刷新或关闭后谜库与登记将全部丢失。',
        at: Date.now(),
      };
      return;
    }
    const [rc, cc] = await Promise.all([idb.count(idb.STORE_RIDDLES), idb.count(idb.STORE_RECORDS)]);
    const er = this.state.riddles.length;
    const ec = this.state.records.length;
    if (rc !== er || cc !== ec) {
      this.state.persistIssue = {
        kind: 'mismatch',
        message: `写入核对不符：谜库应存 ${er} 条 / 实存 ${rc} 条，登记应存 ${ec} 条 / 实存 ${cc} 条，部分数据没有存进本机数据库。`,
        expected: { riddles: er, records: ec },
        actual: { riddles: rc, records: cc },
        at: Date.now(),
      };
    } else {
      this.state.persistIssue = null;
    }
  }

  init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        const [riddles, records, settings, ctx, mode] = await Promise.all([
          idb.getAll<Riddle>(idb.STORE_RIDDLES),
          idb.getAll<OnsiteRecord>(idb.STORE_RECORDS),
          idb.getKV<AppSettings>(KV_SETTINGS),
          loadDataCtx(import.meta.env.BASE_URL),
          idb.storageMode(),
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
        this.state.storageMode = mode;
        await this.verifyPersist(); // 启动即核对一次，暴露上次没存住的数据
        this.state.ready = true;
        this.emit();
      })();
    }
    return this.initPromise;
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
    await this.saveSettings(this.state.settings); // 同步活动清单（saveSettings 内会核对）
    await this.verifyPersist();
    this.emit();
  }

  async clearRiddles(): Promise<void> {
    this.state.riddles = [];
    this.state.settings.event.riddleIds = [];
    await idb.clearStore(idb.STORE_RIDDLES);
    await this.saveSettings(this.state.settings);
    await this.verifyPersist();
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
   * 执行导入计划：先单事务写库（失败整体回滚、内存不动），成功才更新内存，
   * 保证「中途失败回到导入前状态」。导入的谜条按当前校验数据重算谜格。
   */
  async applyBackup(plan: ImportPlan): Promise<{ ok: boolean; error?: string }> {
    const now = Date.now();
    const recheck = (r: Riddle): Riddle => ({
      ...r,
      check: { ...validateRiddle(r, this.state.ctx), checkedAt: now },
    });
    const planned: ImportPlan = {
      ...plan,
      freshRiddles: plan.freshRiddles.map(recheck),
      overwriteRiddles: plan.overwriteRiddles.map(recheck),
    };
    const nextRiddles = mergeRiddles(this.state.riddles, planned);
    const nextRecords = mergeRecords(this.state.records, planned);
    const nextSettings = mergeSettings(planned, nextRiddles, this.state.settings);
    const ok = await idb.restoreAll({
      riddles: [...planned.overwriteRiddles, ...planned.freshRiddles],
      records: [...planned.overwriteRecords, ...planned.freshRecords],
      kv: { key: KV_SETTINGS, value: nextSettings },
    });
    if (!ok) {
      return { ok: false, error: '写入本机数据库失败，已回到导入前状态，原有数据未受影响' };
    }
    this.state.riddles = nextRiddles;
    this.state.records = nextRecords;
    this.state.settings = nextSettings;
    await this.verifyPersist();
    this.emit();
    return { ok: true };
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

/** 整包备份下载：谜库 + 登记记录 + 设置 → 单个 JSON 文件（含导出时间/条数/来源） */
export function downloadBackup(): void {
  const s = store.getState();
  const backup = buildBackup(s.riddles, s.records, s.settings, s.storageMode === 'mem' ? '内存模式' : 'IndexedDB');
  downloadText(exportFileName('整包备份', 'json'), JSON.stringify(backup, null, 2), 'application/json;charset=utf-8');
}
