import { useEffect, useRef, useState } from 'react';
import { MARKET_TOTAL_SYMBOL } from '../../../shared/constants';
import type {
  AlertDirection,
  AlertDispatchPayload,
  DesktopShellState,
  MarketDashboardState,
  MonitorConfig,
} from '../../../shared/types';
import { playAlertSound } from '../audio/alertSound';
import {
  formatClockTime,
  formatPhaseLabel,
  formatPrice,
  formatSignedPct,
  formatSignedTurnover,
  formatSlopeTrend,
  formatTurnover,
  formatVolumeState,
  getSignedToneClass,
  resolveSymbolChangePct,
  resolveSymbolPrice,
  resolveSymbolTurnover,
} from '../utils/format';

const PULSE_DURATION_MS = 6000;

export function HudView() {
  const [market, setMarket] = useState<MarketDashboardState | null>(null);
  const [shell, setShell] = useState<DesktopShellState | null>(null);
  const [monitorConfig, setMonitorConfig] = useState<MonitorConfig | null>(null);
  const [activeAlert, setActiveAlert] = useState<AlertDispatchPayload | null>(null);
  const [watchlistExpanded, setWatchlistExpanded] = useState<boolean>(true);
  const pulseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void window.api.getShellState().then(setShell).catch(() => {});
    void window.api.getMonitorConfig().then(setMonitorConfig).catch(() => {});
    void window.api
      .getMarketState()
      .then((initial) => {
        if (initial) setMarket(initial);
      })
      .catch(() => {});

    const unsubMarket = window.api.onMarketStateUpdated((next) => {
      setMarket(next);
    });
    const unsubShell = window.api.onShellStateUpdated((next) => {
      setShell(next);
    });
    const unsubMonitor = window.api.onMonitorConfigUpdated((next) => {
      setMonitorConfig(next);
    });
    const unsubAlert = window.api.onAlertTriggered((payload) => {
      setActiveAlert(payload);
      if (pulseTimerRef.current) {
        clearTimeout(pulseTimerRef.current);
      }
      pulseTimerRef.current = setTimeout(() => {
        setActiveAlert(null);
        pulseTimerRef.current = null;
      }, PULSE_DURATION_MS);

      // 仅由常驻 HUD 窗口统一发声，避免与详情浮层重复叠音；静音时不发声
      void playAlertSound(payload.direction, payload.muted);
    });

    return () => {
      unsubMarket();
      unsubShell();
      unsubMonitor();
      unsubAlert();
      if (pulseTimerRef.current) {
        clearTimeout(pulseTimerRef.current);
      }
    };
  }, []);

  const total = market?.marketTotal ?? null;
  const status = market?.status ?? null;
  const isDegraded = Boolean(status?.degraded || status?.stale || total?.degraded);
  const volBadge = formatVolumeState(total?.metrics?.volumeState);
  const slopeTrend = formatSlopeTrend(
    total?.metrics?.slope,
    total?.metrics?.windowMultiple,
    monitorConfig?.surgeSlopeThreshold ?? 3.0,
    monitorConfig?.shrinkSlopeThreshold ?? -3.0
  );
  const opacityPct = Math.round((shell?.settings.hudOpacity ?? 0.9) * 100);

  const pulseClass = activeAlert
    ? activeAlert.direction === 'SURGE'
      ? 'pulse-surge'
      : 'pulse-shrink'
    : '';

  const statusDotClass = isDegraded
    ? 'warn'
    : volBadge.tone === 'up'
      ? 'up'
      : volBadge.tone === 'down'
        ? 'down'
        : '';

  const handleSimulate = (direction: AlertDirection) => {
    void window.api.simulateAlert(direction, MARKET_TOTAL_SYMBOL).catch(() => {});
  };

  const watchlistItems = market?.watchlist ?? [];

  return (
    <div className="hud-viewport">
      <section className={`hud-shell ${pulseClass}`}>
        {/* 顶部拖拽栏 + 快捷按钮 */}
        <header className="hud-header drag-region">
          <div className="hud-brand">
            <span className={`status-dot ${statusDotClass}`} />
            <span>A 股能量看板</span>
            <span className="badge badge-muted">{formatPhaseLabel(status?.phase)}</span>
            {status?.mode === 'REPLAY' && <span className="badge badge-flat">复盘</span>}
          </div>

          <div className="hud-actions no-drag">
            <button
              type="button"
              className={`icon-btn ${shell?.settings.alwaysOnTop ? 'active' : ''}`}
              title={shell?.settings.alwaysOnTop ? '已置顶（点击取消置顶）' : '点击置顶'}
              onClick={() => void window.api.setAlwaysOnTop(!(shell?.settings.alwaysOnTop ?? true))}
            >
              顶
            </button>
            <button
              type="button"
              className={`icon-btn ${shell?.settings.muted ? 'warn' : ''}`}
              title={shell?.settings.muted ? '已静音（点击取消静音）' : '点击静音'}
              onClick={() => void window.api.setMuted(!(shell?.settings.muted ?? false))}
            >
              {shell?.settings.muted ? '静' : '音'}
            </button>
            <button
              type="button"
              className="icon-btn"
              title="展开详情浮层"
              onClick={() => void window.api.openDetail({ symbol: MARKET_TOTAL_SYMBOL, tab: 'chart' })}
            >
              详
            </button>
            <button
              type="button"
              className="icon-btn"
              title="最小化至系统托盘"
              onClick={() => void window.api.hideHud()}
            >
              ×
            </button>
          </div>
        </header>

        {/* 老板键冲突提示 */}
        {shell?.bossKeyStatus.conflictMessage && (
          <div
            className="hud-conflict-banner no-drag"
            role="alert"
            onClick={() => void window.api.openDetail({ tab: 'settings' })}
            title="点击前往设置改绑老板键"
          >
            ⚠ {shell.bossKeyStatus.conflictMessage}
          </div>
        )}

        {/* 核心 Hero 区：沪深两市总成交额 + 同比 + 预测全天 + 趋势斜率脉冲 */}
        <div
          className="hud-hero no-drag"
          onClick={() => void window.api.openDetail({ symbol: MARKET_TOTAL_SYMBOL, tab: 'chart' })}
          title="点击展开两市分时能量对比图"
        >
          <div className="hud-hero-top">
            <span className="hud-hero-label">沪深两市总成交额（沪+深，不含北证）</span>
            <div style={{ display: 'flex', gap: '4px' }}>
              {isDegraded && (
                <span className="badge badge-warn">{status?.stale ? '陈旧' : '降级'}</span>
              )}
              <span className={`badge badge-${volBadge.tone}`}>{volBadge.label}</span>
            </div>
          </div>

          <div className="hud-hero-value">
            <span className="hud-total-amount">
              {total && total.cumTurnover !== null ? formatTurnover(total.cumTurnover) : '降级/无数据'}
            </span>
            <span
              className={getSignedToneClass(total?.metrics?.cumRatioPct)}
              style={{ fontSize: '12px', fontWeight: 600 }}
            >
              {total?.metrics?.cumRatioPct !== null && total?.metrics?.cumRatioPct !== undefined
                ? `${formatSignedPct(total.metrics.cumRatioPct, 1)} / ${formatSignedTurnover(total.metrics.cumDiff)}`
                : '同比待比对'}
            </span>
          </div>

          <div className="hud-hero-sub">
            <span>预测全天 {formatTurnover(total?.metrics?.predictedFullDayTurnover)}</span>
            <span className={`slope-chip slope-${slopeTrend.tone}`}>
              <span className="slope-arrow">{slopeTrend.arrow}</span>
              <span>{slopeTrend.label}</span>
            </span>
          </div>
        </div>

        {/* 四大核心指数精简行：点位、涨跌幅、成交额、口径角标、放缩量徽章 */}
        <div className="hud-list-section no-drag">
          <div className="hud-index-list">
            {(market?.indices ?? []).slice(0, 4).map((item) => {
              const price = resolveSymbolPrice(item);
              const pct = resolveSymbolChangePct(item);
              const turnover = resolveSymbolTurnover(item);
              const badge = formatVolumeState(item.metrics?.volumeState);
              const toneClass = getSignedToneClass(pct);
              return (
                <div
                  key={item.symbol}
                  className="hud-quote-row"
                  onClick={() => void window.api.openDetail({ symbol: item.symbol, tab: 'chart' })}
                  title={`点击查看 ${item.name} 分时对比图`}
                >
                  <div className="hud-quote-name">
                    <span className="quote-title">{item.name}</span>
                    {item.scope && <span className="scope-tag">{item.scope}</span>}
                  </div>
                  <span className="hud-quote-price">{formatPrice(price)}</span>
                  <span className={`hud-quote-pct ${toneClass}`}>{formatSignedPct(pct, 2)}</span>
                  <span className="hud-quote-turn">
                    {turnover !== null ? formatTurnover(turnover) : '降级'}
                  </span>
                  <span className={`badge badge-compact badge-${item.degraded && turnover === null ? 'warn' : badge.tone}`}>
                    {item.degraded && turnover === null ? '降级' : badge.label}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* 自选股精简列表（可滚动 / 可折叠） */}
        <div className={`hud-watchlist-section no-drag ${watchlistExpanded ? '' : 'collapsed'}`}>
          <div className="hud-section-bar">
            <button
              type="button"
              className="section-toggle-btn"
              onClick={() => setWatchlistExpanded((v) => !v)}
            >
              <span>{watchlistExpanded ? '▾' : '▸'} 自选股 ({watchlistItems.length})</span>
            </button>
            <button
              type="button"
              className="icon-btn"
              title="管理自选股（添加/删除/排序/单股阈值）"
              onClick={() => void window.api.openDetail({ tab: 'watchlist' })}
            >
              + 管理
            </button>
          </div>

          {watchlistExpanded && (
            <div className="hud-watchlist-scroll">
              {watchlistItems.length === 0 ? (
                <div
                  className="hud-watchlist-empty"
                  onClick={() => void window.api.openDetail({ tab: 'watchlist' })}
                >
                  暂无自选股，点击「+ 管理」搜索添加
                </div>
              ) : (
                watchlistItems.map((item) => {
                  const price = resolveSymbolPrice(item);
                  const pct = resolveSymbolChangePct(item);
                  const turnover = resolveSymbolTurnover(item);
                  const badge = formatVolumeState(item.metrics?.volumeState);
                  const toneClass = getSignedToneClass(pct);
                  return (
                    <div
                      key={item.symbol}
                      className="hud-quote-row"
                      onClick={() => void window.api.openDetail({ symbol: item.symbol, tab: 'chart' })}
                      title={`点击查看 ${item.name} (${item.symbol}) 分时能量图`}
                    >
                      <div className="hud-quote-name">
                        <span className="quote-title">{item.name}</span>
                        <span className="quote-code">{item.symbol.slice(0, 6)}</span>
                      </div>
                      <span className="hud-quote-price">{formatPrice(price)}</span>
                      <span className={`hud-quote-pct ${toneClass}`}>{formatSignedPct(pct, 2)}</span>
                      <span className="hud-quote-turn">
                        {turnover !== null ? formatTurnover(turnover) : '降级'}
                      </span>
                      <span
                        className={`badge badge-compact badge-${item.degraded && turnover === null ? 'warn' : badge.tone}`}
                      >
                        {item.degraded && turnover === null ? '降级' : badge.label}
                      </span>
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>

        {/* 呼吸告警即时横幅 */}
        {activeAlert && (
          <div
            className={`hud-alert-banner no-drag ${activeAlert.direction === 'SURGE' ? 'surge' : 'shrink'}`}
            onClick={() =>
              void window.api.openDetail({ symbol: activeAlert.symbol, tab: 'alerts' })
            }
            title="点击查看异动事件流"
          >
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {activeAlert.isSimulated ? '[模拟测试] ' : ''}
              {activeAlert.name} · {activeAlert.direction === 'SURGE' ? '急放' : '急缩'} (
              {formatSignedPct(activeAlert.slope, 2)}/分 · {activeAlert.windowMultiple.toFixed(2)}x)
            </span>
            {activeAlert.muted && <span className="badge badge-warn">静音</span>}
          </div>
        )}

        {/* 底部极简状态条：数据源、更新时间、延迟/降级提示、透明度滑块、快捷操作 */}
        <footer className="hud-footer no-drag">
          <div className="hud-footer-row">
            <span className="hud-status-text">
              源：{status?.activeSnapshotProvider ?? status?.activeIntradayProvider ?? '—'}
              {status?.lastLatencyMs !== null && status?.lastLatencyMs !== undefined
                ? ` (${Math.round(status.lastLatencyMs)}ms)`
                : ''}
              {' · '}
              {formatClockTime(status?.lastUpdatedAt)}
              {isDegraded ? ' · 降级' : ''}
            </span>
            <label className="opacity-control" title={`透明度 ${opacityPct}%`}>
              <span>透 {opacityPct}%</span>
              <input
                type="range"
                min={30}
                max={100}
                step={5}
                value={opacityPct}
                className="opacity-slider"
                onChange={(e) => void window.api.setHudOpacity(Number(e.target.value) / 100)}
              />
            </label>
          </div>

          <div className="hud-footer-row">
            <span>老板键：{shell?.settings.bossKey ?? 'Alt+Shift+A'}</span>
            <div style={{ display: 'flex', gap: '4px' }}>
              <button
                type="button"
                className="icon-btn"
                onClick={() => void window.api.refreshMarketNow()}
              >
                刷新
              </button>
              <button
                type="button"
                className="icon-btn"
                onClick={() => void window.api.openDetail({ tab: 'settings' })}
              >
                设置
              </button>
              {shell?.isDev && (
                <>
                  <button
                    type="button"
                    className="icon-btn"
                    style={{ color: '#ff7b72' }}
                    title="开发测试：触发模拟急放告警（不伪装实盘）"
                    onClick={() => handleSimulate('SURGE')}
                  >
                    测急放
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    style={{ color: '#56d364' }}
                    title="开发测试：触发模拟急缩告警（不伪装实盘）"
                    onClick={() => handleSimulate('SHRINK')}
                  >
                    测急缩
                  </button>
                </>
              )}
            </div>
          </div>
        </footer>
      </section>
    </div>
  );
}
