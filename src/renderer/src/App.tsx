import { useEffect, useState } from 'react';
import type { BootstrapState } from '../../shared/types';

export function App() {
  const [state, setState] = useState<BootstrapState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    window.api
      .getBootstrapState()
      .then(setState)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      });
  }, []);

  return (
    <main
      style={{
        padding: '20px',
        minHeight: '100vh',
        boxSizing: 'border-box',
        background: '#0e1117',
        color: '#e6edf3',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
      }}
    >
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h1 style={{ margin: 0, fontSize: '16px', fontWeight: 600 }}>A 股实时能量看板</h1>
        <span style={{ fontSize: '12px', color: '#8b949e' }}>Phase 1 脚手架</span>
      </header>

      {error && (
        <div
          style={{
            padding: '10px 12px',
            borderRadius: '6px',
            background: 'rgba(248, 81, 73, 0.12)',
            border: '1px solid rgba(248, 81, 73, 0.4)',
            fontSize: '12px',
            color: '#ff7b72',
          }}
        >
          初始化失败：{error}
        </div>
      )}

      {state ? (
        <section
          style={{
            padding: '12px',
            borderRadius: '8px',
            background: '#161b22',
            border: '1px solid #30363d',
            fontSize: '12px',
            lineHeight: 1.8,
          }}
        >
          <div>Electron：{state.electronVersion}（Node {state.nodeVersion}）</div>
          <div>
            SQLite 本地库：{state.dbReady ? '已就绪（node:sqlite）' : '未就绪'} · 交易日历{' '}
            {state.retention.tradingDaysCount} 天 · 自选股 {state.retention.watchlistCount} 只
          </div>
          <div>
            同花顺 API Key：
            {state.secretStatus.configured
              ? `已配置（来源：${state.secretStatus.source}）`
              : '未配置'}
          </div>
        </section>
      ) : (
        !error && <div style={{ fontSize: '12px', color: '#8b949e' }}>正在加载运行状态…</div>
      )}
    </main>
  );
}
