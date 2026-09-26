// IndexedDB 轻封装（离线优先；无 IndexedDB 环境自动降级为内存存储）
// 写操作返回是否真正落库，并提供 count() 供写入后核对条数
const DB_NAME = 'app-024-lantern-riddle';
const DB_VERSION = 1;
export const STORE_RIDDLES = 'riddles';
export const STORE_RECORDS = 'records';
export const STORE_KV = 'kv';

export type BackendMode = 'idb' | 'memory';

let dbPromise: Promise<IDBDatabase | null> | null = null;
let backendMode: BackendMode = typeof indexedDB === 'undefined' ? 'memory' : 'idb';
let lastWriteError: string | null = null;

/** 当前实际使用的存储后端：idb=可持久化；memory=刷新/关闭页面即丢 */
export function backend(): BackendMode {
  return backendMode;
}

/** 最近一次持久化写入的失败信息（写入成功时清除） */
export function lastError(): string | null {
  return lastWriteError;
}

function noteWrite(ok: boolean, what: string): boolean {
  lastWriteError = ok ? null : `${what}未能写入本机数据库`;
  return ok;
}

function openDB(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') { backendMode = 'memory'; resolve(null); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_RIDDLES)) {
        const s = db.createObjectStore(STORE_RIDDLES, { keyPath: 'id' });
        s.createIndex('no', 'no', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_RECORDS)) {
        const s = db.createObjectStore(STORE_RECORDS, { keyPath: 'id' });
        s.createIndex('riddleId', 'riddleId', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_KV)) db.createObjectStore(STORE_KV, { keyPath: 'key' });
    };
    req.onsuccess = () => { backendMode = 'idb'; resolve(req.result); };
    req.onerror = () => { backendMode = 'memory'; resolve(null); };
    req.onblocked = () => { backendMode = 'memory'; resolve(null); };
  });
  return dbPromise;
}

// 内存降级（测试/隐私模式）
const mem = new Map<string, Map<string, unknown>>();
function memStore(name: string): Map<string, unknown> {
  let m = mem.get(name);
  if (!m) { m = new Map(); mem.set(name, m); }
  return m;
}

async function tx<T>(store: string, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest): Promise<{ ok: boolean; result: T | null }> {
  const db = await openDB();
  if (!db) return { ok: false, result: null };
  return new Promise((resolve) => {
    try {
      const t = db.transaction(store, mode);
      const req = run(t.objectStore(store));
      req.onsuccess = () => resolve({ ok: true, result: req.result as T });
      req.onerror = () => resolve({ ok: false, result: null });
    } catch { resolve({ ok: false, result: null }); }
  });
}

export async function getAll<T>(store: string): Promise<T[]> {
  const { ok, result } = await tx<T[]>(store, 'readonly', (s) => s.getAll());
  if (ok && result) return result;
  return [...memStore(store).values()] as T[];
}

/** 实际落库条数（供写入后核对）；内存模式返回 null */
export async function count(store: string): Promise<number | null> {
  const db = await openDB();
  if (!db) return null;
  const { ok, result } = await tx<number>(store, 'readonly', (s) => s.count());
  return ok ? result : null;
}

export async function put<T extends { id?: string; key?: string }>(store: string, value: T): Promise<boolean> {
  const db = await openDB();
  if (!db) { memStore(store).set((value.id ?? value.key) as string, value); return true; }
  const { ok } = await tx(store, 'readwrite', (s) => s.put(value));
  if (!ok) memStore(store).set((value.id ?? value.key) as string, value);
  return noteWrite(ok, '数据');
}

export async function putMany<T extends { id?: string; key?: string }>(store: string, values: T[]): Promise<boolean> {
  const db = await openDB();
  if (!db) {
    const m = memStore(store);
    for (const v of values) m.set((v.id ?? v.key) as string, v);
    return true;
  }
  const ok = await new Promise<boolean>((resolve) => {
    try {
      const t = db.transaction(store, 'readwrite');
      const os = t.objectStore(store);
      for (const v of values) os.put(v);
      t.oncomplete = () => resolve(true);
      t.onerror = () => resolve(false);
      t.onabort = () => resolve(false);
    } catch { resolve(false); }
  });
  if (!ok) {
    const m = memStore(store);
    for (const v of values) m.set((v.id ?? v.key) as string, v);
  }
  return noteWrite(ok, '批量数据');
}

export async function del(store: string, key: string): Promise<boolean> {
  const db = await openDB();
  if (!db) { memStore(store).delete(key); return true; }
  const { ok } = await tx(store, 'readwrite', (s) => s.delete(key));
  if (!ok) memStore(store).delete(key);
  return noteWrite(ok, '删除操作');
}

export async function clearStore(store: string): Promise<boolean> {
  const db = await openDB();
  if (!db) { memStore(store).clear(); return true; }
  const { ok } = await tx(store, 'readwrite', (s) => s.clear());
  if (!ok) memStore(store).clear();
  return noteWrite(ok, '清空操作');
}

/** 整表替换（单事务 clear + 批量 put），备份导入/回滚用；失败返回 false */
export async function replaceAll<T extends { id?: string; key?: string }>(store: string, values: T[]): Promise<boolean> {
  const db = await openDB();
  if (!db) {
    const m = memStore(store);
    m.clear();
    for (const v of values) m.set((v.id ?? v.key) as string, v);
    return true;
  }
  const ok = await new Promise<boolean>((resolve) => {
    try {
      const t = db.transaction(store, 'readwrite');
      const os = t.objectStore(store);
      os.clear();
      for (const v of values) os.put(v);
      t.oncomplete = () => resolve(true);
      t.onerror = () => resolve(false);
      t.onabort = () => resolve(false);
    } catch { resolve(false); }
  });
  return noteWrite(ok, '整表替换');
}

export async function getKV<T>(key: string): Promise<T | null> {
  const { ok, result } = await tx<{ key: string; value: T }>(STORE_KV, 'readonly', (s) => s.get(key));
  if (ok) return result ? result.value : null;
  const v = memStore(STORE_KV).get(key) as { value: T } | undefined;
  return v?.value ?? null;
}

export async function setKV<T>(key: string, value: T): Promise<boolean> {
  return put(STORE_KV, { key, value });
}
