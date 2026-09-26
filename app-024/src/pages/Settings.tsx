// 设置：活动信息 / 打印默认 / 奖品预设 / 整包备份与恢复 / 清空
import { useRef, useState } from 'react';
import { useAppState } from '../ui/router';
import { riddleToRow, stringifyCSV, withBOM, RIDDLE_CSV_HEADERS } from '../lib/csv';
import { downloadText, formatDateTime } from '../lib/format';
import { downloadBackup, exportFileName, store } from '../lib/store';
import { parseBackup, planImport, type ImportPlan } from '../lib/backup';

export function Settings() {
  const state = useAppState();
  const { event, print, prizes } = state.settings;
  const [ev, setEv] = useState(event);
  const [pr, setPr] = useState(print);
  const [newPrize, setNewPrize] = useState('');
  const [notice, setNotice] = useState('');
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [importError, setImportError] = useState('');
  const [importing, setImporting] = useState(false);
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

  const onBackupFile = async (file: File | undefined) => {
    if (!file) return;
    setImportError('');
    setPlan(null);
    const parsed = parseBackup(await file.text());
    if (backupFileRef.current) backupFileRef.current.value = '';
    if (!parsed.ok) { setImportError(parsed.error); return; }
    setPlan(planImport(parsed.backup, state.riddles, state.records));
  };

  const confirmRestore = async () => {
    if (!plan || importing) return;
    setImporting(true);
    const res = await store.applyBackup(plan);
    setImporting(false);
    if (!res.ok) {
      setImportError(res.error ?? '导入失败，已回到导入前状态');
      setPlan(null);
      return;
    }
    setNotice(`整包恢复完成：新增谜条 ${plan.freshRiddles.length} 条、覆盖 ${plan.overwriteRiddles.length} 条；`
      + `新增登记 ${plan.freshRecords.length} 条、覆盖 ${plan.overwriteRecords.length} 条；设置已替换`);
    setPlan(null);
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

  const issue = state.persistIssue;

  return (
    <div>
      <div className="page-head"><h1>设置</h1></div>
      {notice && <div className="notice">{notice}<button className="notice-x" onClick={() => setNotice('')} aria-label="关闭">×</button></div>}

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
          <h3>存储状态</h3>
          {state.storageMode === 'mem' ? (
            <p className="bad-text">⚠ 内存模式：本机数据库不可用，数据只保存在内存中，<b>刷新或关闭页面后全部丢失</b>。请尽快导出整包备份。</p>
          ) : issue ? (
            <p className="bad-text">⚠ {issue.message}</p>
          ) : (
            <p className="ok-text">✓ 本机数据库（IndexedDB）正常，谜库 {state.riddles.length} 条、登记 {state.records.length} 条均已落库核对。</p>
          )}
          {issue?.kind === 'mismatch' && issue.expected && issue.actual && (
            <p className="muted small">
              最近核对 {formatDateTime(issue.at)}：谜库应存 {issue.expected.riddles} / 实存 {issue.actual.riddles}，
              登记应存 {issue.expected.records} / 实存 {issue.actual.records}
            </p>
          )}
        </div>

        <div className="panel">
          <h3>整包备份 / 恢复</h3>
          <p className="muted small">把谜库、登记记录和设置导出为一个 JSON 文件（含导出时间、条数与来源）；恢复时先预览新增与覆盖，确认后才写库，失败自动回到导入前状态。</p>
          <div className="btn-row wrap">
            <button className="btn btn-primary" onClick={downloadBackup}>⬇ 导出整包备份（{state.riddles.length} 谜 + {state.records.length} 登记 + 设置）</button>
            <button className="btn" onClick={() => { setImportError(''); backupFileRef.current?.click(); }}>⬆ 导入整包备份…</button>
            <input ref={backupFileRef} type="file" accept=".json,application/json" hidden onChange={(e) => void onBackupFile(e.target.files?.[0])} />
          </div>
          {importError && <p className="msg msg-bad">{importError}</p>}
          {plan && (
            <div className="panel panel-import restore-preview">
              <h4>恢复预览 — 确认后才写库</h4>
              <p className="muted small">
                文件导出时间：{plan.backup.exportedAt ? formatDateTime(Date.parse(plan.backup.exportedAt)) : '未知'}
                {plan.backup.source.event && <> · 来源活动：{plan.backup.source.event}</>}
                {plan.backup.source.host && <>（{plan.backup.source.host}）</>}
                <> · 文件记录：谜 {plan.backup.counts.riddles} 条 / 登记 {plan.backup.counts.records} 条</>
              </p>
              <ul className="check-list">
                <li>谜条：<b className="ok-text">新增 {plan.freshRiddles.length} 条</b>，<b className="warn-text">覆盖 {plan.overwriteRiddles.length} 条</b>
                  {plan.renumbered > 0 && <span className="warn-text">（{plan.renumbered} 条谜号冲突，将自动重新编号）</span>}
                </li>
                <li>登记记录：<b className="ok-text">新增 {plan.freshRecords.length} 条</b>，<b className="warn-text">覆盖 {plan.overwriteRecords.length} 条</b>
                  {plan.orphanRecords > 0 && <span className="muted">（{plan.orphanRecords} 条登记对应的谜条不存在，保留但显示为「?」）</span>}
                </li>
                <li>设置：<b className="warn-text">整体替换</b>（活动信息、打印默认、奖品预设）</li>
                {(plan.backup.dataInvalidSkipped ?? 0) > 0 && (
                  <li className="bad-text">文件中有 {plan.backup.dataInvalidSkipped} 条数据无效，已跳过</li>
                )}
              </ul>
              <div className="btn-row">
                <button className="btn btn-primary" disabled={importing} onClick={() => void confirmRestore()}>
                  {importing ? '正在写库…' : '确认恢复'}
                </button>
                <button className="btn btn-ghost" disabled={importing} onClick={() => setPlan(null)}>取消</button>
              </div>
            </div>
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
          <p className="muted small">谜库 CSV 导入在「谜库」页右上角；示例文件见 <a href={`${import.meta.env.BASE_URL}samples/riddles.csv`} download>riddles.csv</a>。全部数据保存在本机 IndexedDB，导出文件请自行留存。</p>
        </div>
      </div>
    </div>
  );
}
