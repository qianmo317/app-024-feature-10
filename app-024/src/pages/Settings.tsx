// 设置：活动信息 / 打印默认 / 奖品预设 / 整包备份恢复 / 导入导出 / 清空
import { useRef, useState } from 'react';
import { useAppState } from '../ui/router';
import { riddleToRow, stringifyCSV, withBOM, RIDDLE_CSV_HEADERS } from '../lib/csv';
import { downloadText, formatDateTime } from '../lib/format';
import { DEFAULT_SETTINGS, downloadFullBackup, exportFileName, store } from '../lib/store';
import { parseBackup, previewBackup, type BackupData, type BackupPreview } from '../lib/backup';

export function Settings() {
  const state = useAppState();
  const { event, print, prizes } = state.settings;
  const [ev, setEv] = useState(event);
  const [pr, setPr] = useState(print);
  const [newPrize, setNewPrize] = useState('');
  const [notice, setNotice] = useState('');
  const [backupPrev, setBackupPrev] = useState<{ data: BackupData; preview: BackupPreview } | null>(null);
  const backupFileRef = useRef<HTMLInputElement>(null);

  const saveEvent = () => void store.saveSettings({ event: { ...ev, riddleIds: event.riddleIds } }).then(() => setNotice('活动信息已保存'));
  const savePrint = () => void store.saveSettings({ print: pr }).then(() => setNotice('打印默认已保存'));

  const addPrize = () => {
    const p = newPrize.trim();
    if (!p || prizes.includes(p)) return;
    void store.saveSettings({ prizes: [...prizes, p] });
    setNewPrize('');
  };
  const delPrize = (p: string) => void store.saveSettings({ prizes: prizes.filter((x) => x !== p) });

  const exportRiddles = () => {
    const csv = stringifyCSV([RIDDLE_CSV_HEADERS, ...state.riddles.map(riddleToRow)]);
    downloadText(exportFileName('谜库', 'csv'), withBOM(csv));
  };

  const exportRecords = () => {
    const rows = state.records.map((rec) => {
      const r = state.riddles.find((x) => x.id === rec.riddleId);
      return [r?.no ?? '', r?.surface ?? '', r?.answer ?? '', rec.winnerName ?? '', rec.winnerRef ?? '',
        rec.prize, rec.code ?? '', new Date(rec.at).toLocaleString('zh-CN'), rec.note ?? ''];
    });
    const csv = stringifyCSV([['谜号', '谜面', '谜底', '猜中者', '联系方式', '奖项', '兑奖号码', '登记时间', '备注'], ...rows]);
    downloadText(exportFileName('现场登记', 'csv'), withBOM(csv));
  };

  const exportBackup = () => {
    downloadFullBackup();
    setNotice(`已导出整包备份（谜库 ${state.riddles.length} 条 · 登记 ${state.records.length} 条 · 设置），请妥善留存`);
  };

  const onBackupFile = async (file: File | undefined) => {
    if (!file) return;
    const text = await file.text();
    const parsed = parseBackup(text);
    if (!parsed.ok) {
      setNotice(`备份文件无法读取：${parsed.error}`);
    } else {
      setBackupPrev({ data: parsed.data, preview: previewBackup(parsed.data, state, DEFAULT_SETTINGS) });
    }
    if (backupFileRef.current) backupFileRef.current.value = '';
  };

  const confirmBackupImport = async () => {
    if (!backupPrev) return;
    try {
      const r = await store.importBackup(backupPrev.data);
      setNotice(
        `恢复完成：谜库新增 ${r.riddlesAdded} 条、覆盖 ${r.riddlesOverwritten} 条` +
        `${r.renumbered ? `、谜号冲突重新编号 ${r.renumbered} 条` : ''}；` +
        `登记新增 ${r.recordsAdded} 条、覆盖 ${r.recordsOverwritten} 条` +
        (r.settingsApplied ? '；设置已覆盖' : '；设置保持不变'),
      );
    } catch (e) {
      setNotice(`导入失败：${e instanceof Error ? e.message : String(e)}`);
    }
    setBackupPrev(null);
  };

  const clearRecords = async () => {
    if (!confirm(`确定清空全部 ${state.records.length} 条登记记录？此操作不可恢复。`)) return;
    await store.clearRecords();
    setNotice('现场登记已清空');
  };
  const clearRiddles = async () => {
    if (!confirm(`确定清空谜库全部 ${state.riddles.length} 条谜？此操作不可恢复。`)) return;
    await store.clearRiddles();
    setNotice('谜库已清空');
  };

  return (
    <div>
      <div className="page-head"><h1>设置</h1></div>
      {notice && <div className="notice">{notice}<button className="notice-x" onClick={() => setNotice('')} aria-label="关闭">×</button></div>}

      {backupPrev && (
        <div className="panel panel-import">
          <h3>备份恢复预览（确认后才写库）</h3>
          <p className="muted">
            导出时间：<b>{backupPrev.preview.exportedAt ? formatDateTime(backupPrev.preview.exportedAt) : '未知'}</b> ·
            来源：<b>{backupPrev.preview.source}</b> ·
            文件内含：谜库 {backupPrev.preview.fileCounts.riddles} 条、登记 {backupPrev.preview.fileCounts.records} 条
            {backupPrev.preview.hasSettings ? '、设置' : ''}
          </p>
          <p>
            谜库：<b className="ok-text">新增 {backupPrev.preview.riddlesAdded} 条</b> ·
            <b className="warn-text"> 覆盖 {backupPrev.preview.riddlesOverwritten} 条</b>
            {backupPrev.preview.renumbered > 0 && <b className="warn-text"> · 谜号冲突将重新编号 {backupPrev.preview.renumbered} 条</b>}
            <br />
            登记：<b className="ok-text">新增 {backupPrev.preview.recordsAdded} 条</b> ·
            <b className="warn-text"> 覆盖 {backupPrev.preview.recordsOverwritten} 条</b>
            <br />
            设置：{backupPrev.preview.hasSettings
              ? <b className="warn-text">将覆盖当前活动信息、打印默认与奖品预设</b>
              : <span className="muted">文件不含设置，保留当前设置</span>}
          </p>
          <p className="muted small">确认后整包写入并核对条数；中途失败会自动回滚到导入前状态。</p>
          <div className="btn-row">
            <button className="btn btn-primary" onClick={() => void confirmBackupImport()}>确认恢复</button>
            <button className="btn btn-ghost" onClick={() => setBackupPrev(null)}>取消</button>
          </div>
        </div>
      )}

      <div className="settings-grid">
        <div className="panel">
          <h3>活动信息</h3>
          <label className="field"><span>活动名称</span>
            <input className="input" value={ev.title} onChange={(e) => setEv({ ...ev, title: e.target.value })} />
          </label>
          <label className="field"><span>主办方（打印落款）</span>
            <input className="input" value={ev.host} onChange={(e) => setEv({ ...ev, host: e.target.value })} placeholder="例：××社区工会" />
          </label>
          <label className="field"><span>活动日期</span>
            <input className="input" type="date" value={ev.date} onChange={(e) => setEv({ ...ev, date: e.target.value })} />
          </label>
          <button className="btn btn-primary" onClick={saveEvent}>保存活动信息</button>
        </div>

        <div className="panel">
          <h3>打印默认参数</h3>
          <div className="field-row">
            <label className="field"><span>卡片宽（mm）</span>
              <input className="input" type="number" min={30} max={200} value={pr.cardWmm}
                onChange={(e) => setPr({ ...pr, cardWmm: Math.max(20, Number(e.target.value) || 0) })} />
            </label>
            <label className="field"><span>卡片高（mm）</span>
              <input className="input" type="number" min={30} max={290} value={pr.cardHmm}
                onChange={(e) => setPr({ ...pr, cardHmm: Math.max(20, Number(e.target.value) || 0) })} />
            </label>
            <label className="field"><span>每页条数</span>
              <select className="input" value={pr.perPage} onChange={(e) => setPr({ ...pr, perPage: Number(e.target.value) })}>
                {[4, 6, 8, 9, 12].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
          </div>
          <label className="field"><span>落款文字</span>
            <input className="input" value={pr.hostLine} onChange={(e) => setPr({ ...pr, hostLine: e.target.value })} />
          </label>
          <button className="btn btn-primary" onClick={savePrint}>保存打印默认</button>
        </div>

        <div className="panel">
          <h3>奖品预设</h3>
          <div className="btn-row">
            <input className="input" value={newPrize} onChange={(e) => setNewPrize(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addPrize(); }} placeholder="新增奖项名" />
            <button className="btn" onClick={addPrize}>添加</button>
          </div>
          <ul className="prize-list">
            {prizes.map((p) => (
              <li key={p}><span className="badge">{p}</span><button className="btn btn-ghost btn-sm" onClick={() => delPrize(p)}>移除</button></li>
            ))}
            {!prizes.length && <li className="muted">暂无奖项（现场登记时奖项下拉为空）</li>}
          </ul>
        </div>

        <div className="panel">
          <h3>整包备份与恢复</h3>
          <p className="muted small">
            把谜库、登记记录和设置打包成一个 JSON 文件（写明导出时间、条数与来源）。
            换电脑、清理浏览器或活动现场交班前，请先导出备份；恢复时会先预览再确认。
          </p>
          <div className="btn-row wrap">
            <button className="btn btn-primary" onClick={exportBackup}>⬇ 导出整包备份（JSON）</button>
            <button className="btn" onClick={() => backupFileRef.current?.click()}>⬆ 导入备份…</button>
            <input ref={backupFileRef} type="file" accept=".json,application/json" hidden onChange={(e) => void onBackupFile(e.target.files?.[0])} />
          </div>
          {state.persist.mode !== 'persistent' && (
            <p className="bad-text small">
              ⚠ {state.persist.mode === 'memory'
                ? '当前为内存模式，数据不会被持久保存，请立即导出备份。'
                : `存储异常：${state.persist.detail ?? ''}，请立即导出备份。`}
            </p>
          )}
        </div>

        <div className="panel">
          <h3>数据管理</h3>
          <div className="btn-row wrap">
            <button className="btn" onClick={() => void store.recheckAll().then(() => setNotice('已重新校验全部谜格'))}>🔄 重新校验全部谜格</button>
            <button className="btn" onClick={exportRiddles}>⬇ 导出谜库 CSV（UTF-8 BOM）</button>
            <button className="btn" onClick={exportRecords}>⬇ 导出现场登记表 CSV（UTF-8 BOM）</button>
          </div>
          <div className="btn-row wrap">
            <button className="btn btn-danger" onClick={() => void clearRecords()}>清空现场登记（{state.records.length}）</button>
            <button className="btn btn-danger" onClick={() => void clearRiddles()}>清空谜库（{state.riddles.length}）</button>
          </div>
          <p className="muted small">谜库 CSV 导入在「谜库」页右上角；示例文件见 <a href={`${import.meta.env.BASE_URL}samples/riddles.csv`} download>riddles.csv</a>。全部数据保存在本机 IndexedDB，清空前建议先导出整包备份。</p>
        </div>
      </div>
    </div>
  );
}
