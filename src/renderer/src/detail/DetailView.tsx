import { useEffect, useRef, useState } from 'react';
import { MARKET_TOTAL_SYMBOL, SIMULATED_ALERT_PREFIX } from '../../../shared/constants';
import type {
  AlertDirection,
  AlertEventRow,
  BootstrapState,
  BossKeyStatus,
  DesktopShellState,
  DetailTab,
  MarketDashboardState,
} from '../../../shared/types';
import {
  formatClockTime,
  formatPhaseLabel,
  formatSignedPct,
  formatSignedTurnover,
  formatTurnover,
  formatVolumeState,
  resolveSymbolTurnover,
} from '../utils/format';

export function DetailView() {
  const [bootstrap, setBootstrap] = useState<BootstrapState | null>(null);
  const [market, setMarket] = useState<MarketDashboardState | null>(null);
  const [shell, setShell] = useState<DesktopShellState | null>(null);
  const [alerts, setAlerts] = useState<AlertEventRow[]>([]);
  const [activeTab, setActiveTab] = useState<DetailTab>('chart');
  const [selectedSymbol, setSelectedSymbol] = useState<string>(MARKET_TOTAL_SYMBOL);
  const [bossKeyInput, setBossKeyInput] = useState<string>('Alt+Shift+A');
  const [bossKeyFeedback, setBossKeyFeedback] = useState<BossKeyStatus | null>(null);
  const lastFocusSeqRef = useRef<number>(-1);
  const lastSavedBossKeyRef = useRef<string | null>(null);

  const loadAlerts = () => {
    void window.api
      .getRecentAlerts(undefined, 100)
      .then(setAlerts)
      .catch(() => {});
  };

  useEffect(() => {
    const applyShellState = (next: DesktopShellState, isInitial: boolean) => {
      setShell(next);
      setBossKeyFeedback(next.bossKeyStatus);

      if (isInitial || next.detailFocusSeq !== lastFocusSeqRef.current) {
        lastFocusSeqRef.current = next.detailFocusSeq;
        setActiveTab(next.activeDetailTab);
        setSelectedSymbol(next.activeDetailSymbol);
      }

      if (isInitial || next.settings.bossKey !== lastSavedBossKeyRef.current) {
        lastSavedBossKeyRef.current = next.settings.bossKey;
        setBossKeyInput(next.settings.bossKey);
      }
    };

    void window.api.getBootstrapState().then(setBootstrap).catch(() => {});
    void window.api
      .getShellState()
      .then((initial) => applyShellState(initial, true))
      .catch(() => {});
    void window.api
      .getMarketState()
      .then((initial) => {
        if (initial) setMarket(initial);
      })
      .catch(() => {});
    loadAlerts();

    const unsubMarket = window.api.onMarketStateUpdated(setMarket);
    const unsubShell = window.api.onShellStateUpdated((next) => applyShellState(next, false));
    const unsubAlert = window.api.onAlertTriggered((payload) => {
      setAlerts((prev) => [payload, ...prev.filter((item) => item.id !== payload.id)].slice(0, 100));
    });

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        void window.api.hideDetail();
      }
    };
    window.addEventListener('keydown', onKeyDown);

    return () => {
      unsubMarket();
      unsubShell();
      unsubAlert();
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  const handleSaveBossKey = async () => {
    try {
      const status = await window.api.setBossKey(bossKeyInput);
      setBossKeyFeedback(status);
    } catch (err: unknown) {
      setBossKeyFeedback({
        accelerator: bossKeyFeedback?.accelerator ?? '',
        registered: bossKeyFeedback?.registered ?? false,
        conflictMessage: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleKeepCurrentBossKey = async () => {
    const active = bossKeyFeedback?.accelerator;
    if (!active) return;
    setBossKeyInput(active);
    try {
      const status = await window.api.setBossKey(active);
      setBossKeyFeedback(status);
    } catch {
      // 忽略异常
    }
  };

  const handleSimulate = async (direction: AlertDirection) => {
    try {
      await window.api.simulateAlert(direction, selectedSymbol);
      loadAlerts();
    } catch {
      // 非开发模式或主进程异常时静默忽略
    }
  };

  const selectedIndex =
    selectedSymbol === MARKET_TOTAL_SYMBOL
      ? null
      : (market?.indices.find((i) => i.symbol === selectedSymbol) ??
          market?.watchlist.find((w) => w.symbol === selectedSymbol) ??
          null);

  const metrics =
    selectedSymbol === MARKET_TOTAL_SYMBOL
      ? market?.marketTotal.metrics ?? null
      : selectedIndex?.metrics ?? null;

  const displayName =
    selectedSymbol === MARKET_TOTAL_SYMBOL
      ? '沪深两市总成交额'
      : selectedIndex?.name ?? selectedSymbol;

  const currentTurnover =
    selectedSymbol === MARKET_TOTAL_SYMBOL
      ? market?.marketTotal.cumTurnover ?? null
      : resolveSymbolTurnover(selectedIndex);

  const isReplayMode = market?.status.mode === 'REPLAY';

  const volBadge = formatVolumeState(metrics?.volumeState);
  const opacityPct = Math.round((shell?.settings.hudOpacity ?? 0.9) * 100);

  return (
    <div className="detail-viewport">
      <div className="detail-shell">
        <header className="detail-header drag-region">
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <strong style={{ fontSize: '14px' }}>A 股实时能量看板 · 详情浮层</strong>
            <span className="badge badge-muted">{formatPhaseLabel(market?.status.phase)}</span>
            {market?.status.degraded && <span className="badge badge-warn">数据源降级</span>}
          </div>

          <div className="detail-tabs no-drag">
            <button
              type="button"
              className={`tab-btn ${activeTab === 'chart' ? 'active' : ''}`}
              onClick={() => setActiveTab('chart')}
            >
              能量概览
            </button>
            <button
              type="button"
              className={`tab-btn ${activeTab === 'alerts' ? 'active' : ''}`}
              onClick={() => {
                setActiveTab('alerts');
                loadAlerts();
              }}
            >
              异动事件流 ({alerts.length})
            </button>
            <button
              type="button"
              className={`tab-btn ${activeTab === 'settings' ? 'active' : ''}`}
              onClick={() => setActiveTab('settings')}
            >
              桌面设置
            </button>
            <button
              type="button"
              className="btn"
              title="收起详情浮层（Esc）"
              onClick={() => void window.api.hideDetail()}
            >
              收起 (Esc)
            </button>
          </div>
        </header>

        <main className="detail-body">
          {activeTab === 'chart' && (
            <>
              <div className="symbol-pills">
                <button
                  type="button"
                  className={`pill-btn ${selectedSymbol === MARKET_TOTAL_SYMBOL ? 'active' : ''}`}
                  onClick={() => setSelectedSymbol(MARKET_TOTAL_SYMBOL)}
                >
                  沪深两市
                </button>
                {(market?.indices ?? []).map((idx) => (
                  <button
                    key={idx.symbol}
                    type="button"
                    className={`pill-btn ${selectedSymbol === idx.symbol ? 'active' : ''}`}
                    onClick={() => setSelectedSymbol(idx.symbol)}
                  >
                    {idx.name} ({idx.scope ?? '指数'})
                  </button>
                ))}
                {(market?.watchlist ?? []).map((stock) => (
                  <button
                    key={stock.symbol}
                    type="button"
                    className={`pill-btn ${selectedSymbol === stock.symbol ? 'active' : ''}`}
                    onClick={() => setSelectedSymbol(stock.symbol)}
                  >
                    {stock.name} ({stock.symbol})
                  </button>
                ))}
              </div>

              <section className="panel-card">
                <h2 className="panel-title">
                  <span>
                    {displayName}（{selectedSymbol}）
                  </span>
                  <span className={`badge badge-${volBadge.tone}`}>{volBadge.label}</span>
                </h2>
                <div className="metric-grid">
                  <div className="metric-item">
                    <div className="metric-label">
                      {isReplayMode ? '最近交易日累计成交额' : '今日累计成交额'}
                    </div>
                    <div className="metric-value">{formatTurnover(currentTurnover)}</div>
                  </div>
                  <div className="metric-item">
                    <div className="metric-label">较昨日同期</div>
                    <div
                      className={`metric-value ${
                        metrics?.cumRatioPct !== null && metrics?.cumRatioPct !== undefined
                          ? metrics.cumRatioPct > 0
                            ? 'tone-up'
                            : metrics.cumRatioPct < 0
                              ? 'tone-down'
                              : ''
                          : ''
                      }`}
                    >
                      {formatSignedPct(metrics?.cumRatioPct, 1)} /{' '}
                      {formatSignedTurnover(metrics?.cumDiff)}
                    </div>
                  </div>
                  <div className="metric-item">
                    <div className="metric-label">
                      滚动 {metrics?.slopeWindow ?? 5} 分钟斜率 / 倍数
                    </div>
                    <div className="metric-value">
                      {metrics?.slope !== null && metrics?.slope !== undefined
                        ? `${formatSignedPct(metrics.slope, 2)}/分`
                        : '—'}{' '}
                      ·{' '}
                      {metrics?.windowMultiple !== null && metrics?.windowMultiple !== undefined
                        ? `${metrics.windowMultiple.toFixed(2)}x`
                        : '—'}
                    </div>
                  </div>
                  <div className="metric-item">
                    <div className="metric-label">预测全天成交额</div>
                    <div className="metric-value">
                      {formatTurnover(metrics?.predictedFullDayTurnover)}
                    </div>
                  </div>
                </div>
              </section>

              <section className="panel-card" style={{ color: 'var(--text-secondary)', fontSize: '12px' }}>
                <h2 className="panel-title">
                  <span>分时能量对比图占位（Phase 5 接入 ECharts 双图联动）</span>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void window.api.refreshMarketNow()}
                  >
                    立即刷新
                  </button>
                </h2>
                <div>
                  当前交易日：{market?.status.tradeDate ?? '—'} · 对比基线日：
                  {market?.status.prevTradeDate ?? '—'} · 采集模式：{market?.status.mode ?? '—'} ·
                  快照源：{market?.status.activeSnapshotProvider ?? '—'} · 分时源：
                  {market?.status.activeIntradayProvider ?? '—'} · 最近更新：
                  {formatClockTime(market?.status.lastUpdatedAt)}
                </div>
                {market?.status.degradedReasons.length ? (
                  <div className="tone-warn" style={{ marginTop: '6px' }}>
                    降级原因：{market.status.degradedReasons.join('；')}
                  </div>
                ) : null}
              </section>
            </>
          )}

          {activeTab === 'alerts' && (
            <section className="panel-card">
              <h2 className="panel-title">
                <span>异动告警事件流（SQLite alert_events）</span>
                <div style={{ display: 'flex', gap: '6px' }}>
                  {shell?.isDev && (
                    <>
                      <button
                        type="button"
                        className="btn btn-surge"
                        onClick={() => void handleSimulate('SURGE')}
                      >
                        模拟急放告警
                      </button>
                      <button
                        type="button"
                        className="btn btn-shrink"
                        onClick={() => void handleSimulate('SHRINK')}
                      >
                        模拟急缩告警
                      </button>
                    </>
                  )}
                  <button type="button" className="btn" onClick={loadAlerts}>
                    刷新列表
                  </button>
                </div>
              </h2>

              {alerts.length === 0 ? (
                <div style={{ color: 'var(--text-secondary)', fontSize: '12px', padding: '12px 0' }}>
                  暂无告警记录。开发态可点击右上角「模拟急放/急缩告警」验证落库、Windows 通知、HUD 呼吸高亮与提示音。
                </div>
              ) : (
                <div className="alert-list">
                  {alerts.map((item) => {
                    const isSim = item.message.startsWith(SIMULATED_ALERT_PREFIX);
                    const isSurge = item.direction === 'SURGE';
                    return (
                      <div key={item.id} className={`alert-row ${isSurge ? 'surge' : 'shrink'}`}>
                        <div className="alert-row-head">
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <span className={`badge ${isSurge ? 'badge-up' : 'badge-down'}`}>
                              {isSurge ? '快速放量' : '快速缩量'}
                            </span>
                            {isSim && <span className="badge badge-warn">模拟测试</span>}
                            <strong>
                              {item.name} ({item.symbol})
                            </strong>
                          </div>
                          <span className="alert-row-meta">
                            {item.tradeDate} {formatClockTime(item.createdAt)} · #{item.id}
                          </span>
                        </div>
                        <div className="alert-row-meta">
                          斜率 {formatSignedPct(item.slope, 2)}/分 · 区间倍数{' '}
                          {item.windowMultiple.toFixed(2)}x · 累计同比{' '}
                          {formatSignedPct(item.cumRatio * 100, 1)}
                        </div>
                        <div style={{ fontSize: '12px' }}>{item.message}</div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          )}

          {activeTab === 'settings' && (
            <section className="panel-card">
              <h2 className="panel-title">
                <span>桌面外壳与告警通道设置（持久化至 app_settings）</span>
              </h2>
              <div className="settings-grid">
                <div className="setting-row">
                  <div>
                    <div>HUD 窗口透明度（{opacityPct}%）</div>
                    <div className="setting-desc">支持 30%–100%，重启后自动恢复</div>
                  </div>
                  <input
                    type="range"
                    min={30}
                    max={100}
                    step={5}
                    value={opacityPct}
                    onChange={(e) => void window.api.setHudOpacity(Number(e.target.value) / 100)}
                  />
                </div>

                <div className="setting-row">
                  <div>
                    <div>窗口始终置顶</div>
                    <div className="setting-desc">HUD 与详情浮层置顶显示于其他应用之上</div>
                  </div>
                  <input
                    type="checkbox"
                    checked={shell?.settings.alwaysOnTop ?? true}
                    onChange={(e) => void window.api.setAlwaysOnTop(e.target.checked)}
                  />
                </div>

                <div className="setting-row">
                  <div>
                    <div>静音提醒</div>
                    <div className="setting-desc">
                      开启后仅屏蔽提示音，写库、Windows 通知与 HUD 呼吸高亮照常触发
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={shell?.settings.muted ?? false}
                    onChange={(e) => void window.api.setMuted(e.target.checked)}
                  />
                </div>

                <div className="setting-row">
                  <div>
                    <div>开机自启</div>
                    <div className="setting-desc">登录 Windows 时自动启动并驻留悬浮窗/托盘</div>
                  </div>
                  <input
                    type="checkbox"
                    checked={shell?.settings.autoLaunch ?? false}
                    onChange={(e) => void window.api.setAutoLaunch(e.target.checked)}
                  />
                </div>

                <div className="setting-row">
                  <div>
                    <div>全局老板键（一键显隐所有窗口）</div>
                    <div className="setting-desc">
                      当前生效：
                      {bossKeyFeedback?.registered
                        ? `已生效 (${bossKeyFeedback.accelerator})`
                        : '未注册'}
                    </div>
                    {bossKeyFeedback?.conflictMessage && (
                      <div className="setting-desc tone-warn" role="alert">
                        ⚠ {bossKeyFeedback.conflictMessage}
                      </div>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                    <input
                      type="text"
                      className="text-input"
                      value={bossKeyInput}
                      onChange={(e) => setBossKeyInput(e.target.value)}
                      placeholder="例如 Alt+Shift+A"
                    />
                    <button type="button" className="btn" onClick={() => void handleSaveBossKey()}>
                      应用改绑
                    </button>
                    {bossKeyFeedback?.registered && bossKeyFeedback.conflictMessage && (
                      <button
                        type="button"
                        className="btn"
                        title="清除冲突提示并恢复当前生效快捷键"
                        onClick={() => void handleKeepCurrentBossKey()}
                      >
                        保留当前键
                      </button>
                    )}
                  </div>
                </div>

                {bootstrap && (
                  <div className="setting-row">
                    <div>
                      <div>运行时与本地存储状态</div>
                      <div className="setting-desc">
                        Electron {bootstrap.electronVersion} · SQLite 告警{' '}
                        {bootstrap.retention.alertEventsCount} 条 · 交易日历{' '}
                        {bootstrap.retention.tradingDaysCount} 天 · 同花顺 Key：
                        {bootstrap.secretStatus.configured
                          ? `已配置（${bootstrap.secretStatus.source}）`
                          : '未配置'}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </section>
          )}
        </main>
      </div>
    </div>
  );
}
