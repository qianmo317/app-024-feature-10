import { useEffect, useState } from 'react';
import { useAppState, useRoute, type Route } from './ui/router';
import { RiddleList } from './pages/RiddleList';
import { RiddleEdit } from './pages/RiddleEdit';
import { PrintPage } from './pages/PrintPage';
import { Onsite } from './pages/Onsite';
import { Library } from './pages/Library';
import { Settings } from './pages/Settings';
import { downloadBackup } from './lib/store';

const NAV: { href: string; label: string; match: Route['name'] }[] = [
  { href: '#/', label: '谜库', match: 'list' },
  { href: '#/print', label: '出条打印', match: 'print' },
  { href: '#/onsite', label: '现场登记', match: 'onsite' },
  { href: '#/library', label: '谜格说明', match: 'library' },
  { href: '#/settings', label: '设置', match: 'settings' },
];

export function App() {
  const state = useAppState();
  const route = useRoute();
  const [online, setOnline] = useState(navigator.onLine);
  const [dismissedAt, setDismissedAt] = useState(0); // 已关闭的告警时间戳（新告警会再次弹出）
  const [dismissedDataWarn, setDismissedDataWarn] = useState(false);

  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); };
  }, []);

  const issue = state.persistIssue;
  const showPersistBanner = state.ready && !!issue && issue.at > dismissedAt;
  const showDataBanner = state.ready && !!state.ctx.loadError && !dismissedDataWarn;

  return (
    <div className="app">
      <header className="topbar no-print">
        <div className="topbar-inner">
          <a className="brand" href="#/">
            <span className="brand-lantern" aria-hidden>🏮</span>
            <span>
              <b>元宵灯谜库</b>
              <small>Lantern Riddle Bank</small>
            </span>
          </a>
          <nav className="nav">
            {NAV.map((n) => (
              <a key={n.href} href={n.href} className={route.name === n.match ? 'active' : ''}>{n.label}</a>
            ))}
          </nav>
          <div className="topbar-status">
            {state.ready && issue && (
              <span className="badge badge-danger" title={issue.message}>
                ⚠ {issue.kind === 'memory' ? '内存模式 · 刷新即丢失' : '存储核对不符'}
              </span>
            )}
            {!online && <span className="badge badge-offline">离线模式 · 数据保存在本机</span>}
            {!state.ready && <span className="badge">加载中…</span>}
            {state.ready && state.ctx.loadError && (
              <span className="badge badge-warn" title={state.ctx.loadError}>校验数据未加载</span>
            )}
          </div>
        </div>
      </header>

      {!state.ready ? (
        <main className="container"><p className="muted">正在加载本地数据…</p></main>
      ) : (
        <main className="container">
          {showPersistBanner && issue && (
            <div className="alert-banner alert-danger no-print" role="alert">
              <span className="alert-icon" aria-hidden>⚠</span>
              <div className="alert-body">
                <b>{issue.kind === 'memory' ? '数据没有存进本机数据库' : '数据核对不符，部分数据可能没存住'}</b>
                <p>{issue.message} 建议先导出整包备份留存，再继续登记。</p>
              </div>
              <div className="alert-actions">
                <button className="btn btn-danger" onClick={downloadBackup}>⬇ 立即导出整包备份</button>
                <button className="btn btn-ghost" onClick={() => setDismissedAt(issue.at)}>知道了</button>
              </div>
            </div>
          )}
          {showDataBanner && (
            <div className="alert-banner alert-warn no-print" role="alert">
              <span className="alert-icon" aria-hidden>⚠</span>
              <div className="alert-body">
                <b>拼音 / 部件校验数据未加载</b>
                <p>离线数据包读取失败（{state.ctx.loadError}），谜格校验、谐音候选与拼音提示不可用；谜库与登记功能不受影响。</p>
              </div>
              <div className="alert-actions">
                <button className="btn btn-ghost" onClick={() => setDismissedDataWarn(true)}>知道了</button>
              </div>
            </div>
          )}
          {route.name === 'list' && <RiddleList />}
          {route.name === 'edit' && <RiddleEdit id={route.id} />}
          {route.name === 'print' && <PrintPage />}
          {route.name === 'onsite' && <Onsite />}
          {route.name === 'library' && <Library />}
          {route.name === 'settings' && <Settings />}
        </main>
      )}

      <footer className="footer no-print">
        {state.storageMode === 'mem' ? (
          <span className="bad-text">⚠ 当前为内存模式：数据未写入本机数据库，刷新或关闭页面后全部丢失，请及时导出整包备份</span>
        ) : (
          <span>全部数据保存在本机浏览器（IndexedDB），断网可用；建议定期在「设置」页导出整包备份</span>
        )}
      </footer>
    </div>
  );
}
