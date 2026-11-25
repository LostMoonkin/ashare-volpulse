import { useEffect, useRef, useState } from 'react';
import { MARKET_TOTAL_SYMBOL } from '../../../shared/constants';
import type {
  AlertDirection,
  AlertDispatchPayload,
  DesktopShellState,
  MarketDashboardState,
} from '../../../shared/types';
import { playAlertSound } from '../audio/alertSound';
import {
  formatClockTime,
  formatPhaseLabel,
  formatSignedPct,
  formatSignedTurnover,
  formatTurnover,
  formatVolumeState,
  resolveSymbolChangePct,
  resolveSymbolTurnover,
} from '../utils/format';

const PULSE_DURATION_MS = 6000;

export function HudView() {
  const [market, setMarket] = useState<MarketDashboardState | null>(null);
  const [shell, setShell] = useState<DesktopShellState | null>(null);
  const [activeAlert, setActiveAlert] = useState<AlertDispatchPayload | null>(null);
  const pulseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void window.api.getShellState().then(setShell).catch(() => {});
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

  return (
    <div className="hud-viewport">
      <section className={`hud-shell ${pulseClass}`}>
        {/* 顶部拖拽栏 + 快捷按钮 */}
        <header className="hud-header drag-region">
          <div className="hud-brand">
            <span className={`status-dot ${statusDotClass}`} />
            <span>A 股能量看板</span>
            <span className="badge badge-muted">{formatPhaseLabel(status?.phase)}</span>
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

        {/* 核心 Hero 区：沪深两市总成交额 */}
        <div
          className="hud-hero no-drag"
          onClick={() => void window.api.openDetail({ symbol: MARKET_TOTAL_SYMBOL, tab: 'chart' })}
          title="点击展开详情浮层"
        >
          <div className="hud-hero-top">
            <span className="hud-hero-label">沪深两市总成交额（沪+深，不含北证）</span>
            <div style={{ display: 'flex', gap: '4px' }}>
              {isDegraded && <span className="badge badge-warn">{status?.stale ? '陈旧' : '降级'}</span>}
              <span className={`badge badge-${volBadge.tone}`}>{volBadge.label}</span>
            </div>
          </div>

          <div className="hud-hero-value">
            <span className="hud-total-amount">
              {total && total.cumTurnover !== null ? formatTurnover(total.cumTurnover) : '暂不可用'}
            </span>
            <span
              className={
                total?.metrics?.cumRatioPct !== null && total?.metrics?.cumRatioPct !== undefined
                  ? total.metrics.cumRatioPct >= 0
                    ? 'tone-up'
                    : 'tone-down'
                  : ''
              }
              style={{ fontSize: '13px', fontWeight: 600 }}
            >
              {formatSignedPct(total?.metrics?.cumRatioPct, 1)}
            </span>
          </div>

          <div className="hud-hero-sub">
            <span>较昨同期 {formatSignedTurnover(total?.metrics?.cumDiff)}</span>
            <span>预测全天 {formatTurnover(total?.metrics?.predictedFullDayTurnover)}</span>
          </div>
        </div>

        {/* 四大核心指数精简卡片（点击直接打开该标的详情浮层） */}
        <div className="hud-indices no-drag">
          {(market?.indices ?? []).slice(0, 4).map((item) => {
            const pct = resolveSymbolChangePct(item);
            const turnover = resolveSymbolTurnover(item);
            const toneClass =
              pct === undefined || pct === null ? '' : pct >= 0 ? 'tone-up' : 'tone-down';
            return (
              <div
                key={item.symbol}
                className="hud-index-card"
                onClick={() => void window.api.openDetail({ symbol: item.symbol, tab: 'chart' })}
                title={`点击查看 ${item.name} 详情`}
              >
                <div className="hud-index-row">
                  <span style={{ fontWeight: 600 }}>{item.name}</span>
                  {item.scope && <span className="scope-tag">{item.scope}</span>}
                </div>
                <div className="hud-index-row">
                  <span className={toneClass}>{formatSignedPct(pct, 2)}</span>
                  <span style={{ color: 'var(--text-secondary)' }}>
                    {turnover !== null ? formatTurnover(turnover) : '降级'}
                  </span>
                </div>
              </div>
            );
          })}
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

        {/* 底部极简状态条 + 透明度滑块 + 开发态模拟测试入口 */}
        <footer className="hud-footer no-drag">
          <div className="hud-footer-row">
            <span>
              源：{status?.activeSnapshotProvider ?? status?.activeIntradayProvider ?? '—'} · 更新{' '}
              {formatClockTime(status?.lastUpdatedAt)}
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
