import { useEffect, useState } from 'react';
import { useAppState, useRoute, type Route } from './ui/router';
import { downloadFullBackup } from './lib/store';
import { RiddleList } from './pages/RiddleList';
import { RiddleEdit } from './pages/RiddleEdit';
import { PrintPage } from './pages/PrintPage';
import { Onsite } from './pages/Onsite';
import { Library } from './pages/Library';
import { Settings } from './pages/Settings';

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

  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); };
  }, []);

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
            {!online && <span className="badge badge-offline">离线模式 · 数据保存在本机</span>}
            {!state.ready && <span className="badge">加载中…</span>}
            {state.ready && state.persist.mode === 'memory' && (
              <span className="badge badge-danger">⚠ 内存模式 · 刷新即丢</span>
            )}
            {state.ready && state.persist.mode === 'degraded' && (
              <span className="badge badge-danger" title={state.persist.detail}>⚠ 存储异常</span>
            )}
            {state.ready && state.ctx.loadError && (
              <span className="badge badge-warn" title={state.ctx.loadError}>校验数据未加载</span>
            )}
          </div>
        </div>
      </header>

      {state.ready && state.persist.mode !== 'persistent' && (
        <div className="persist-banner no-print" role="alert">
          <div className="persist-banner-inner">
            <span className="persist-banner-icon" aria-hidden>⚠</span>
            <div className="persist-banner-text">
              <b>{state.persist.mode === 'memory' ? '数据只保存在内存中，刷新或关闭页面后全部消失' : '数据写入本机数据库后核对不符，可能没有真正存住'}</b>
              <span>
                {state.persist.mode === 'memory'
                  ? '当前环境无法使用本机数据库（IndexedDB），谜库与登记不会被持久保存。请立即导出整包备份，避免白忙一场。'
                  : `${state.persist.detail ?? ''}。继续登记前请先导出整包备份。`}
              </span>
            </div>
            <button className="btn" onClick={() => downloadFullBackup()}>⬇ 立即导出整包备份</button>
          </div>
        </div>
      )}
      {state.ready && !!state.ctx.loadError && (
        <div className="persist-banner persist-banner-warn no-print" role="alert">
          <div className="persist-banner-inner">
            <span className="persist-banner-icon" aria-hidden>⚠</span>
            <div className="persist-banner-text">
              <b>拼音 / 部件校验数据未加载（{state.ctx.loadError}）</b>
              <span>谜格自动校验与现场分级提示不完整；建库、登记与打印不受影响。可到「设置」重新校验全部谜格。</span>
            </div>
          </div>
        </div>
      )}

      {!state.ready ? (
        <main className="container"><p className="muted">正在加载本地数据…</p></main>
      ) : (
        <main className="container">
          {route.name === 'list' && <RiddleList />}
          {route.name === 'edit' && <RiddleEdit id={route.id} />}
          {route.name === 'print' && <PrintPage />}
          {route.name === 'onsite' && <Onsite />}
          {route.name === 'library' && <Library />}
          {route.name === 'settings' && <Settings />}
        </main>
      )}

      <footer className="footer no-print">
        <span>
          {state.ready && state.persist.mode === 'memory'
            ? '⚠ 当前为内存模式：数据不会持久保存，请定期在「设置」导出整包备份'
            : '全部数据保存在本机浏览器（IndexedDB），断网可用；换机或清理浏览器前请在「设置」导出整包备份'}
        </span>
      </footer>
    </div>
  );
}
