import { useEffect, useRef, useState } from 'react';
import { MARKET_TOTAL_SYMBOL } from '../../../shared/constants';
import type {
  AlertDirection,
  AlertEventRow,
  BossKeyStatus,
  DesktopShellState,
  DetailTab,
  MarketDashboardState,
  MonitorConfig,
  WatchlistItemRow,
} from '../../../shared/types';
import {
  formatClockTime,
  formatPhaseLabel,
  formatPrice,
  formatSignedPct,
  formatSignedTurnover,
  formatTurnover,
  formatVolumeState,
  resolveSymbolChangePct,
  resolveSymbolPrice,
  resolveSymbolTurnover,
} from '../utils/format';
import { AlertsPanel } from './AlertsPanel';
import { EnergyDualChart } from './EnergyDualChart';
import { SettingsPanel } from './SettingsPanel';
import { WatchlistPanel } from './WatchlistPanel';

export function DetailView() {
  const [market, setMarket] = useState<MarketDashboardState | null>(null);
  const [shell, setShell] = useState<DesktopShellState | null>(null);
  const [monitorConfig, setMonitorConfig] = useState<MonitorConfig | null>(null);
  const [watchlistRows, setWatchlistRows] = useState<WatchlistItemRow[]>([]);
  const [alerts, setAlerts] = useState<AlertEventRow[]>([]);
  const [activeTab, setActiveTab] = useState<DetailTab>('chart');
  const [selectedSymbol, setSelectedSymbol] = useState<string>(MARKET_TOTAL_SYMBOL);
  const [bossKeyInput, setBossKeyInput] = useState<string>('Alt+Shift+A');
  const [bossKeyFeedback, setBossKeyFeedback] = useState<BossKeyStatus | null>(null);
  const lastFocusSeqRef = useRef<number>(-1);
  const lastSavedBossKeyRef = useRef<string | null>(null);

  const loadAlerts = () => {
    void window.api
      .getRecentAlerts(undefined, 150)
      .then(setAlerts)
      .catch(() => {});
  };

  const loadWatchlist = () => {
    void window.api
      .getWatchlist()
      .then(setWatchlistRows)
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

    void window.api
      .getShellState()
      .then((initial) => applyShellState(initial, true))
      .catch(() => {});
    void window.api
      .getMonitorConfig()
      .then(setMonitorConfig)
      .catch(() => {});
    void window.api
      .getMarketState()
      .then((initial) => {
        if (initial) setMarket(initial);
      })
      .catch(() => {});
    loadAlerts();
    loadWatchlist();

    const unsubMarket = window.api.onMarketStateUpdated(setMarket);
    const unsubShell = window.api.onShellStateUpdated((next) => applyShellState(next, false));
    const unsubAlert = window.api.onAlertTriggered((payload) => {
      setAlerts((prev) => [payload, ...prev.filter((item) => item.id !== payload.id)].slice(0, 150));
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
    const status = await window.api.setBossKey(bossKeyInput);
    setBossKeyFeedback(status);
  };

  const handleSimulate = async (direction: AlertDirection) => {
    await window.api.simulateAlert(direction, selectedSymbol);
    loadAlerts();
  };

  const handleJumpToChart = (symbol: string) => {
    setSelectedSymbol(symbol);
    setActiveTab('chart');
  };

  const selectedSnapshot =
    selectedSymbol === MARKET_TOTAL_SYMBOL
      ? null
      : (market?.indices.find((i) => i.symbol === selectedSymbol) ??
          market?.watchlist.find((w) => w.symbol === selectedSymbol) ??
          null);

  const metrics =
    selectedSymbol === MARKET_TOTAL_SYMBOL
      ? market?.marketTotal.metrics ?? null
      : selectedSnapshot?.metrics ?? null;

  const displayName =
    selectedSymbol === MARKET_TOTAL_SYMBOL
      ? '沪深两市总成交额'
      : selectedSnapshot?.name ?? selectedSymbol;

  const currentTurnover =
    selectedSymbol === MARKET_TOTAL_SYMBOL
      ? market?.marketTotal.cumTurnover ?? null
      : resolveSymbolTurnover(selectedSnapshot);

  const currentPrice = selectedSnapshot ? resolveSymbolPrice(selectedSnapshot) : null;
  const currentChangePct = selectedSnapshot ? resolveSymbolChangePct(selectedSnapshot) : null;
  const auctionTurnover =
    selectedSymbol === MARKET_TOTAL_SYMBOL
      ? market?.marketTotal.auctionTurnover ?? null
      : selectedSnapshot?.auctionTurnover ?? null;

  const isReplayMode = market?.status.mode === 'REPLAY';
  const targetDegraded =
    selectedSymbol === MARKET_TOTAL_SYMBOL
      ? Boolean(market?.marketTotal.degraded)
      : Boolean(selectedSnapshot?.degraded);
  const targetDegradedReason =
    selectedSymbol === MARKET_TOTAL_SYMBOL
      ? market?.marketTotal.degradedReason ?? null
      : selectedSnapshot?.degradedReason ?? null;

  const volBadge = formatVolumeState(metrics?.volumeState);

  return (
    <div className="detail-viewport">
      <div className="detail-shell">
        <header className="detail-header drag-region">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <strong style={{ fontSize: '14px' }}>A 股实时能量看板</strong>
            <span className="badge badge-muted">{formatPhaseLabel(market?.status.phase)}</span>
            {isReplayMode && <span className="badge badge-flat">复盘</span>}
            {market?.status.degraded && <span className="badge badge-warn">数据源降级</span>}
          </div>

          <div className="detail-tabs no-drag">
            <button
              type="button"
              className={`tab-btn ${activeTab === 'chart' ? 'active' : ''}`}
              onClick={() => setActiveTab('chart')}
            >
              分时能量
            </button>
            <button
              type="button"
              className={`tab-btn ${activeTab === 'watchlist' ? 'active' : ''}`}
              onClick={() => {
                setActiveTab('watchlist');
                loadWatchlist();
              }}
            >
              自选股 ({watchlistRows.length})
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
              设置
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
              {/* 标的切换胶囊：沪深两市 + 四大指数 + 全部自选股 */}
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
                    className={`pill-btn pill-stock ${selectedSymbol === stock.symbol ? 'active' : ''}`}
                    onClick={() => setSelectedSymbol(stock.symbol)}
                  >
                    {stock.name}
                  </button>
                ))}
              </div>

              {/* 顶部关键指标卡 */}
              <section className="panel-card compact-card">
                <div className="detail-symbol-head">
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <strong style={{ fontSize: '14px' }}>{displayName}</strong>
                    <span className="muted-mono">{selectedSymbol}</span>
                    {selectedSnapshot?.scope && (
                      <span className="scope-tag">{selectedSnapshot.scope}</span>
                    )}
                    {currentPrice !== null && (
                      <span style={{ fontSize: '13px', fontWeight: 600 }}>
                        {formatPrice(currentPrice)}{' '}
                        <span
                          className={
                            currentChangePct === null
                              ? ''
                              : currentChangePct >= 0
                                ? 'tone-up'
                                : 'tone-down'
                          }
                        >
                          {formatSignedPct(currentChangePct, 2)}
                        </span>
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    {targetDegraded && (
                      <span className="badge badge-warn" title={targetDegradedReason ?? ''}>
                        降级
                      </span>
                    )}
                    <span className={`badge badge-${volBadge.tone}`}>{volBadge.label}</span>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => void window.api.refreshMarketNow()}
                    >
                      立即刷新
                    </button>
                  </div>
                </div>

                <div className="metric-grid">
                  <div className="metric-item">
                    <div className="metric-label">
                      {isReplayMode ? '最近交易日累计成交额' : '今日累计成交额'}
                    </div>
                    <div className="metric-value">
                      {currentTurnover !== null ? formatTurnover(currentTurnover) : '降级/无数据'}
                    </div>
                  </div>
                  <div className="metric-item">
                    <div className="metric-label">较昨日同期</div>
                    <div
                      className={`metric-value ${
                        metrics?.cumRatioPct !== null && metrics?.cumRatioPct !== undefined
                          ? metrics.cumRatioPct >= 0
                            ? 'tone-up'
                            : 'tone-down'
                          : ''
                      }`}
                    >
                      {metrics?.cumRatioPct !== null && metrics?.cumRatioPct !== undefined
                        ? `${formatSignedPct(metrics.cumRatioPct, 1)} / ${formatSignedTurnover(metrics.cumDiff)}`
                        : '—'}
                    </div>
                  </div>
                  <div className="metric-item">
                    <div className="metric-label">
                      滚动 {metrics?.slopeWindow ?? monitorConfig?.slopeWindow ?? 5}m 斜率 / 倍数
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
                    <div className="metric-label">预测全天 / 09:25 竞价</div>
                    <div className="metric-value" style={{ fontSize: '14px' }}>
                      {formatTurnover(metrics?.predictedFullDayTurnover)} /{' '}
                      <span style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>
                        {formatTurnover(auctionTurnover)}
                      </span>
                    </div>
                  </div>
                </div>
              </section>

              {/* ECharts 上下联动双图 */}
              <section className="panel-card chart-panel-card">
                <EnergyDualChart
                  market={market}
                  symbol={selectedSymbol}
                  alerts={alerts}
                  slopeWindow={metrics?.slopeWindow ?? monitorConfig?.slopeWindow ?? 5}
                />
                <div className="chart-meta-bar">
                  <span>
                    交易日：{market?.status.tradeDate ?? '—'} vs 基线日：
                    {market?.status.prevTradeDate ?? '—'} · 快照源：
                    {market?.status.activeSnapshotProvider ?? '—'} · 分时源：
                    {market?.status.activeIntradayProvider ?? '—'} · 更新：
                    {formatClockTime(market?.status.lastUpdatedAt)}
                  </span>
                  {market?.status.degradedReasons.length ? (
                    <span className="tone-warn">
                      降级：{market.status.degradedReasons.join('；')}
                    </span>
                  ) : null}
                </div>
              </section>
            </>
          )}

          {activeTab === 'watchlist' && (
            <WatchlistPanel
              watchlistRows={watchlistRows}
              market={market}
              globalConfig={monitorConfig}
              onWatchlistChanged={(rows) => setWatchlistRows(rows)}
              onJumpToChart={handleJumpToChart}
            />
          )}

          {activeTab === 'alerts' && (
            <AlertsPanel
              alerts={alerts}
              isDev={Boolean(shell?.isDev)}
              onRefresh={loadAlerts}
              onSimulate={handleSimulate}
              onJumpToChart={handleJumpToChart}
            />
          )}

          {activeTab === 'settings' && (
            <SettingsPanel
              shell={shell}
              monitorConfig={monitorConfig}
              bossKeyInput={bossKeyInput}
              bossKeyFeedback={bossKeyFeedback}
              onBossKeyInputChange={setBossKeyInput}
              onSaveBossKey={handleSaveBossKey}
              onMonitorConfigUpdated={(next) => setMonitorConfig(next)}
            />
          )}
        </main>
      </div>
    </div>
  );
}
