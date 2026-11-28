import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ALLOWED_SLOPE_WINDOWS,
  MARKET_TOTAL_SYMBOL,
  REPLAY_SPEED_MULTIPLIERS,
  type ReplaySpeedMultiplier,
} from '../../../shared/constants';
import type {
  AlertDirection,
  AlertDispatchPayload,
  AlertMatchModeType,
  MarketDashboardState,
  MonitorConfig,
  ReplayMonitorParams,
  ReplaySessionState,
  SlopeWindowOption,
} from '../../../shared/types';
import { playAlertSound } from '../audio/alertSound';
import {
  formatClockTime,
  formatPrice,
  formatSignedPct,
  formatSignedTurnover,
  formatTurnover,
  formatVolumeState,
  getSignedToneClass,
  resolveSymbolChangePct,
  resolveSymbolPrice,
  resolveSymbolTurnover,
} from '../utils/format';
import { EnergyDualChart } from './EnergyDualChart';

interface NumericParamDraftStrings {
  expandThresholdPct: string;
  shrinkThresholdPct: string;
  surgeSlopeThreshold: string;
  surgeMultipleThreshold: string;
  shrinkSlopeThreshold: string;
  shrinkMultipleThreshold: string;
  cooldownMinutes: string;
}

function toParamDraftStrings(params: ReplayMonitorParams): NumericParamDraftStrings {
  return {
    expandThresholdPct: String(params.expandThresholdPct),
    shrinkThresholdPct: String(params.shrinkThresholdPct),
    surgeSlopeThreshold: String(params.surgeSlopeThreshold),
    surgeMultipleThreshold: String(params.surgeMultipleThreshold),
    shrinkSlopeThreshold: String(params.shrinkSlopeThreshold),
    shrinkMultipleThreshold: String(params.shrinkMultipleThreshold),
    cooldownMinutes: String(params.cooldownMinutes),
  };
}

function parseFiniteOrFallback(raw: string, fallback: number): number {
  const trimmed = raw.trim();
  if (!trimmed) return fallback;
  const num = Number(trimmed);
  return Number.isFinite(num) ? num : fallback;
}

/** 仅在「动态播放推进」且未开启回放静音、且该帧新触发告警时发声；全天直达/Seek/单步均不发声 */
export function resolveReplaySoundDirection(
  state: Pick<ReplaySessionState, 'triggerReason' | 'newlyTriggeredAlerts'>,
  selectedSymbol: string,
  replayMuted: boolean
): AlertDirection | null {
  if (replayMuted) return null;
  if (state.triggerReason !== 'play') return null;
  if (state.newlyTriggeredAlerts.length === 0) return null;
  const preferred = state.newlyTriggeredAlerts.find((ev) => ev.symbol === selectedSymbol);
  return (preferred ?? state.newlyTriggeredAlerts[0]).direction;
}

/** 判定普通「分时能量」页签是否应展示盘后无实盘告警引导入口 */
export function shouldShowPostCloseReplayGuide(params: {
  market: MarketDashboardState | null;
  isCliReplay: boolean;
  todayAlertsCount: number;
  alertsReady?: boolean;
}): boolean {
  if (params.isCliReplay) return false;
  if (params.alertsReady === false) return false;
  const status = params.market?.status;
  if (!status || !status.tradeDate) return false;
  const isPostCloseOrStaticReview =
    status.mode === 'REPLAY' || status.phase === 'POST_MARKET' || status.phase === 'CLOSED_DAY';
  return isPostCloseOrStaticReview && params.todayAlertsCount === 0;
}

export interface ReplayConsoleContentProps {
  replayState: ReplaySessionState | null;
  selectedSymbol: string;
  replayMuted: boolean;
  paramsOpen: boolean;
  paramDraft: NumericParamDraftStrings | null;
  flashAlert: AlertDispatchPayload | null;
  applyTip: string | null;
  busy: boolean;
  alertSymbolFilter: 'ALL' | 'SELECTED';
  alertDirectionFilter: 'ALL' | AlertDirection;
  onSelectSymbol: (symbol: string) => void;
  onSelectDate: (tradeDate: string) => void;
  onRefreshDates: () => void;
  onToggleMuted: () => void;
  onToggleParamsOpen: () => void;
  onParamFieldChange: (key: keyof NumericParamDraftStrings, val: string) => void;
  onPatchParams: (patch: Partial<ReplayMonitorParams>) => void;
  onCommitParamDraft: () => void;
  onResetParams: () => void;
  onApplyParamsToLive: () => void;
  onRestart: () => void;
  onStep: (delta: number) => void;
  onTogglePlay: () => void;
  onSeek: (stepIndex: number) => void;
  onSetSpeed: (speed: ReplaySpeedMultiplier) => void;
  onAlertSymbolFilterChange: (filter: 'ALL' | 'SELECTED') => void;
  onAlertDirectionFilterChange: (filter: 'ALL' | AlertDirection) => void;
  onClickAlertItem: (item: AlertDispatchPayload) => void;
}

export function ReplayConsoleContent({
  replayState,
  selectedSymbol,
  replayMuted,
  paramsOpen,
  paramDraft,
  flashAlert,
  applyTip,
  busy,
  alertSymbolFilter,
  alertDirectionFilter,
  onSelectSymbol,
  onSelectDate,
  onRefreshDates,
  onToggleMuted,
  onToggleParamsOpen,
  onParamFieldChange,
  onPatchParams,
  onCommitParamDraft,
  onResetParams,
  onApplyParamsToLive,
  onRestart,
  onStep,
  onTogglePlay,
  onSeek,
  onSetSpeed,
  onAlertSymbolFilterChange,
  onAlertDirectionFilterChange,
  onClickAlertItem,
}: ReplayConsoleContentProps) {
  const market = replayState?.marketState ?? null;
  const availableDates = replayState?.availableDates ?? [];
  const totalSteps = replayState?.totalSteps ?? 0;
  const stepIndex = replayState?.stepIndex ?? 0;
  const maxStep = Math.max(0, totalSteps - 1);
  const currentTimeLabel = replayState?.currentTimeLabel ?? '--:--';
  const playing = Boolean(replayState?.playing);
  const params = replayState?.params ?? null;
  const alerts = replayState?.alerts ?? [];
  const totalDayAlertCount = replayState?.totalDayAlertCount ?? 0;
  const alertCounts = replayState?.alertCountBySymbol ?? {};

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

  const targetDegraded =
    selectedSymbol === MARKET_TOTAL_SYMBOL
      ? Boolean(market?.marketTotal.degraded)
      : Boolean(selectedSnapshot?.degraded);
  const targetDegradedReason =
    selectedSymbol === MARKET_TOTAL_SYMBOL
      ? market?.marketTotal.degradedReason ?? null
      : selectedSnapshot?.degradedReason ?? null;

  const volBadge = formatVolumeState(metrics?.volumeState);
  const pulseClass = flashAlert
    ? flashAlert.direction === 'SURGE'
      ? 'replay-pulse-surge'
      : 'replay-pulse-shrink'
    : '';

  const filteredAlerts = useMemo(() => {
    return alerts.filter((ev) => {
      if (alertSymbolFilter === 'SELECTED' && ev.symbol !== selectedSymbol) return false;
      if (alertDirectionFilter !== 'ALL' && ev.direction !== alertDirectionFilter) return false;
      return true;
    });
  }, [alerts, alertSymbolFilter, alertDirectionFilter, selectedSymbol]);

  const currentDateInfo = availableDates.find((d) => d.tradeDate === replayState?.tradeDate) ?? null;

  return (
    <div className="replay-console-root">
      {/* 顶部控制台栏：日期切换 + 状态标识 + 独立静音开关 + 调参抽屉开关 */}
      <section className={`panel-card compact-card replay-toolbar-card ${pulseClass}`}>
        <div className="replay-toolbar">
          <div className="replay-toolbar-left">
            <label className="replay-date-label">
              <span>回放交易日</span>
              <select
                className="text-input replay-date-select"
                value={replayState?.tradeDate ?? ''}
                disabled={availableDates.length === 0 || busy}
                onChange={(e) => {
                  if (e.target.value) {
                    onSelectDate(e.target.value);
                  }
                }}
              >
                {availableDates.length === 0 ? (
                  <option value="">暂无已录制交易日</option>
                ) : (
                  availableDates.map((d) => (
                    <option key={d.tradeDate} value={d.tradeDate}>
                      {d.tradeDate}
                      {d.hasPrevBaseline && d.prevTradeDate
                        ? ` (基线 ${d.prevTradeDate})`
                        : ' (无昨日基线 · 降级)'}
                    </option>
                  ))
                )}
              </select>
            </label>
            <button
              type="button"
              className="btn btn-sm"
              title="刷新本地已录制交易日列表与当前日期数据"
              disabled={busy}
              onClick={onRefreshDates}
            >
              刷新日期
            </button>
            {replayState?.tradeDate && (
              <span className={`badge ${playing ? 'badge-up' : 'badge-flat'}`}>
                {playing ? `播放中 ${replayState.speed}x` : '已暂停'} · {currentTimeLabel} (
                {stepIndex}/{maxStep})
              </span>
            )}
            {currentDateInfo && !currentDateInfo.hasPrevBaseline && (
              <span
                className="badge badge-warn"
                title="该交易日缺少上一交易日完整录制基线，同比与斜率指标按降级处理且绝不补零"
              >
                无昨日基线
              </span>
            )}
          </div>

          <div className="replay-toolbar-right">
            <button
              type="button"
              className={`btn btn-sm ${replayMuted ? '' : 'btn-accent'}`}
              title={
                replayMuted
                  ? '回放提示音当前静音；开启后仅在动态播放推进触发告警时发声'
                  : '点击静音回放提示音'
              }
              onClick={onToggleMuted}
            >
              {replayMuted ? '🔇 回放静音' : '🔊 回放发声'}
            </button>
            <button
              type="button"
              className={`btn btn-sm ${paramsOpen || replayState?.isCustomParams ? 'btn-accent' : ''}`}
              onClick={onToggleParamsOpen}
            >
              参数调优
              {replayState?.isCustomParams ? ' · 已自定义' : ''}
            </button>
          </div>
        </div>

        {flashAlert && (
          <div
            className={`replay-flash-banner ${flashAlert.direction === 'SURGE' ? 'surge' : 'shrink'}`}
          >
            <span>
              <strong>{flashAlert.name}</strong> ({formatClockTime(flashAlert.createdAt)} ·{' '}
              {flashAlert.direction === 'SURGE' ? '急放量' : '急缩量'}){' '}
              {flashAlert.windowMultiple.toFixed(2)}x · 斜率 {formatSignedPct(flashAlert.slope, 2)}
              /分
            </span>
          </div>
        )}

        {replayState?.error && (
          <div className="replay-error-banner">
            <span className="badge badge-warn">暂无可用回放数据</span>
            <span>{replayState.error}</span>
          </div>
        )}
      </section>

      {/* 可折叠独立临时参数调优区 */}
      {paramsOpen && params && paramDraft && (
        <section className="panel-card compact-card replay-params-card">
          <div className="replay-params-head">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <strong style={{ fontSize: '12px' }}>回放独立告警参数</strong>
              <span className="badge badge-muted">
                {replayState?.isCustomParams ? '当前使用回放临时参数（未改动实盘）' : '当前继承实盘配置'}
              </span>
              {applyTip && <span className="tone-up" style={{ fontSize: '11px' }}>{applyTip}</span>}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy}
                onClick={onCommitParamDraft}
              >
                重新推演
              </button>
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy || !replayState?.isCustomParams}
                onClick={onResetParams}
              >
                重置为实盘配置
              </button>
              <button
                type="button"
                className="btn btn-sm btn-accent"
                disabled={busy}
                onClick={onApplyParamsToLive}
              >
                应用为实盘配置
              </button>
            </div>
          </div>

          <div className="replay-params-grid">
            <label className="inline-check">
              <input
                type="checkbox"
                checked={params.alertsEnabled}
                onChange={(e) => onPatchParams({ alertsEnabled: e.target.checked })}
              />
              <span>开启急缩放推演</span>
            </label>

            <div className="inline-num">
              <span>斜率窗口</span>
              <div className="segmented-group">
                {ALLOWED_SLOPE_WINDOWS.map((winOpt: SlopeWindowOption) => (
                  <button
                    key={winOpt}
                    type="button"
                    className={`seg-btn ${params.slopeWindow === winOpt ? 'active' : ''}`}
                    onClick={() => onPatchParams({ slopeWindow: winOpt })}
                  >
                    {winOpt}m
                  </button>
                ))}
              </div>
            </div>

            <div className="inline-num">
              <span>触发模式</span>
              <div className="segmented-group">
                {(['AND', 'OR'] as const).map((mode: AlertMatchModeType) => (
                  <button
                    key={mode}
                    type="button"
                    className={`seg-btn ${params.matchMode === mode ? 'active' : ''}`}
                    onClick={() => onPatchParams({ matchMode: mode })}
                  >
                    {mode === 'AND' ? '且' : '或'}
                  </button>
                ))}
              </div>
            </div>

            <label className="inline-num">
              <span>放量 ≥</span>
              <input
                type="text"
                inputMode="decimal"
                className="num-input"
                value={paramDraft.expandThresholdPct}
                onChange={(e) => onParamFieldChange('expandThresholdPct', e.target.value)}
                onBlur={onCommitParamDraft}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onCommitParamDraft();
                }}
              />
              <span>%</span>
            </label>

            <label className="inline-num">
              <span>缩量 ≤</span>
              <input
                type="text"
                inputMode="decimal"
                className="num-input"
                value={paramDraft.shrinkThresholdPct}
                onChange={(e) => onParamFieldChange('shrinkThresholdPct', e.target.value)}
                onBlur={onCommitParamDraft}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onCommitParamDraft();
                }}
              />
              <span>%</span>
            </label>

            <label className="inline-num">
              <span>急放斜率 ≥</span>
              <input
                type="text"
                inputMode="decimal"
                className="num-input"
                value={paramDraft.surgeSlopeThreshold}
                onChange={(e) => onParamFieldChange('surgeSlopeThreshold', e.target.value)}
                onBlur={onCommitParamDraft}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onCommitParamDraft();
                }}
              />
              <span>%/分</span>
            </label>

            <label className="inline-num">
              <span>急放倍数 ≥</span>
              <input
                type="text"
                inputMode="decimal"
                className="num-input"
                value={paramDraft.surgeMultipleThreshold}
                onChange={(e) => onParamFieldChange('surgeMultipleThreshold', e.target.value)}
                onBlur={onCommitParamDraft}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onCommitParamDraft();
                }}
              />
              <span>x</span>
            </label>

            <label className="inline-num">
              <span>急缩斜率 ≤</span>
              <input
                type="text"
                inputMode="decimal"
                className="num-input"
                value={paramDraft.shrinkSlopeThreshold}
                onChange={(e) => onParamFieldChange('shrinkSlopeThreshold', e.target.value)}
                onBlur={onCommitParamDraft}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onCommitParamDraft();
                }}
              />
              <span>%/分</span>
            </label>

            <label className="inline-num">
              <span>急缩倍数 ≤</span>
              <input
                type="text"
                inputMode="decimal"
                className="num-input"
                value={paramDraft.shrinkMultipleThreshold}
                onChange={(e) => onParamFieldChange('shrinkMultipleThreshold', e.target.value)}
                onBlur={onCommitParamDraft}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onCommitParamDraft();
                }}
              />
              <span>x</span>
            </label>

            <label className="inline-num">
              <span>冷却</span>
              <input
                type="text"
                inputMode="numeric"
                className="num-input"
                value={paramDraft.cooldownMinutes}
                onChange={(e) => onParamFieldChange('cooldownMinutes', e.target.value)}
                onBlur={onCommitParamDraft}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onCommitParamDraft();
                }}
              />
              <span>分</span>
            </label>
          </div>
        </section>
      )}

      {/* 标的切换胶囊（附带截至当前已触发回放告警计数） */}
      {market && (
        <div className="symbol-pills">
          <button
            type="button"
            className={`pill-btn ${selectedSymbol === MARKET_TOTAL_SYMBOL ? 'active' : ''}`}
            onClick={() => onSelectSymbol(MARKET_TOTAL_SYMBOL)}
          >
            沪深两市
            {(alertCounts[MARKET_TOTAL_SYMBOL] ?? 0) > 0 && (
              <span className="pill-alert-count">{alertCounts[MARKET_TOTAL_SYMBOL]}</span>
            )}
          </button>
          {market.indices.map((idx) => (
            <button
              key={idx.symbol}
              type="button"
              className={`pill-btn ${selectedSymbol === idx.symbol ? 'active' : ''}`}
              onClick={() => onSelectSymbol(idx.symbol)}
            >
              {idx.name} ({idx.scope ?? '指数'})
              {(alertCounts[idx.symbol] ?? 0) > 0 && (
                <span className="pill-alert-count">{alertCounts[idx.symbol]}</span>
              )}
            </button>
          ))}
          {market.watchlist.map((stock) => (
            <button
              key={stock.symbol}
              type="button"
              className={`pill-btn pill-stock ${selectedSymbol === stock.symbol ? 'active' : ''}`}
              onClick={() => onSelectSymbol(stock.symbol)}
            >
              {stock.name}
              {(alertCounts[stock.symbol] ?? 0) > 0 && (
                <span className="pill-alert-count">{alertCounts[stock.symbol]}</span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* 播控条：从头播放 / 单步 / 播放暂停 / 倍速 / 时间轴进度条 Seek */}
      {market && (
        <section className="panel-card compact-card replay-transport-card">
          <div className="replay-transport-controls">
            <div className="replay-transport-buttons">
              <button
                type="button"
                className="btn btn-sm"
                title="从 09:25 从头动态播放"
                disabled={busy || totalSteps === 0}
                onClick={onRestart}
              >
                ⏮ 从头播放
              </button>
              <button
                type="button"
                className="btn btn-sm"
                title="后退 1 分钟（←）"
                disabled={busy || stepIndex <= 0}
                onClick={() => onStep(-1)}
              >
                ◀ -1m
              </button>
              <button
                type="button"
                className="btn btn-sm btn-accent"
                title={playing ? '暂停（Space）' : '播放（Space）'}
                disabled={busy || totalSteps === 0}
                onClick={onTogglePlay}
              >
                {playing ? '⏸ 暂停' : stepIndex >= maxStep ? '▶ 重播' : '▶ 播放'}
              </button>
              <button
                type="button"
                className="btn btn-sm"
                title="前进 1 分钟（→）"
                disabled={busy || stepIndex >= maxStep}
                onClick={() => onStep(1)}
              >
                ▶ +1m
              </button>
              <button
                type="button"
                className="btn btn-sm"
                title="跳至 15:00 全天收盘"
                disabled={busy || stepIndex >= maxStep}
                onClick={() => onSeek(maxStep)}
              >
                ⏭ 15:00
              </button>
            </div>

            <div className="replay-speed-group">
              <span className="replay-speed-label">倍速</span>
              <div className="segmented-group">
                {REPLAY_SPEED_MULTIPLIERS.map((spd) => (
                  <button
                    key={spd}
                    type="button"
                    className={`seg-btn ${replayState?.speed === spd ? 'active' : ''}`}
                    onClick={() => onSetSpeed(spd)}
                  >
                    {spd}x
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="replay-timeline-wrap">
            <input
              type="range"
              aria-label="回放时间轴"
              className="replay-timeline-slider"
              min={0}
              max={maxStep}
              value={stepIndex}
              disabled={totalSteps === 0}
              onChange={(e) => onSeek(Number(e.target.value))}
            />
            <div className="replay-timeline-ticks">
              <span>09:25</span>
              <span>10:30</span>
              <span>11:30 / 13:00</span>
              <span>14:00</span>
              <span>15:00</span>
            </div>
          </div>
        </section>
      )}

      {/* 当前选中标的指标卡 */}
      {market && (
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
                  {formatPrice(currentPrice, selectedSymbol)}{' '}
                  <span className={getSignedToneClass(currentChangePct)}>
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
            </div>
          </div>

          <div className="metric-grid">
            <div className="metric-item">
              <div className="metric-label">回放累计成交额 ({currentTimeLabel})</div>
              <div className="metric-value">
                {currentTurnover !== null ? formatTurnover(currentTurnover) : '降级/无数据'}
              </div>
            </div>
            <div className="metric-item">
              <div className="metric-label">较基线日同期</div>
              <div className={`metric-value ${getSignedToneClass(metrics?.cumRatioPct)}`}>
                {metrics?.cumRatioPct !== null && metrics?.cumRatioPct !== undefined
                  ? `${formatSignedPct(metrics.cumRatioPct, 1)} / ${formatSignedTurnover(metrics.cumDiff)}`
                  : '—'}
              </div>
            </div>
            <div className="metric-item">
              <div className="metric-label">
                滚动 {metrics?.slopeWindow ?? params?.slopeWindow ?? 5}m 斜率 / 倍数
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
      )}

      {/* ECharts 双图联动（与实盘同源绘制，三角完全由回放推演告警驱动） */}
      {market && (
        <section className="panel-card chart-panel-card">
          <EnergyDualChart
            market={market}
            symbol={selectedSymbol}
            alerts={alerts}
            slopeWindow={metrics?.slopeWindow ?? params?.slopeWindow ?? 5}
          />
          <div className="chart-meta-bar">
            <span>
              独立回放：{replayState?.tradeDate ?? '—'} vs 基线日：
              {replayState?.prevTradeDate ?? '无'} · 源：
              {market.status.activeIntradayProvider ?? '本地 SQLite'} · 当前推演时刻：
              {currentTimeLabel}
            </span>
            {market.status.degradedReasons.length > 0 && (
              <span className="tone-warn">降级：{market.status.degradedReasons.join('；')}</span>
            )}
          </div>
        </section>
      )}

      {/* 回放异动事件流（严格仅内存推演，点击直接定位到该标的与分钟） */}
      {market && (
        <section className="panel-card">
          <div className="panel-title">
            <span>
              回放急缩放事件流（截至 {currentTimeLabel} 共 {alerts.length} 条 · 全天共{' '}
              {totalDayAlertCount} 条，点击定位该分钟）
            </span>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              <div className="segmented-group">
                <button
                  type="button"
                  className={`seg-btn ${alertSymbolFilter === 'ALL' ? 'active' : ''}`}
                  onClick={() => onAlertSymbolFilterChange('ALL')}
                >
                  全部标的
                </button>
                <button
                  type="button"
                  className={`seg-btn ${alertSymbolFilter === 'SELECTED' ? 'active' : ''}`}
                  onClick={() => onAlertSymbolFilterChange('SELECTED')}
                >
                  仅当前标的
                </button>
              </div>
              <div className="segmented-group">
                <button
                  type="button"
                  className={`seg-btn ${alertDirectionFilter === 'ALL' ? 'active' : ''}`}
                  onClick={() => onAlertDirectionFilterChange('ALL')}
                >
                  全部
                </button>
                <button
                  type="button"
                  className={`seg-btn ${alertDirectionFilter === 'SURGE' ? 'active' : ''}`}
                  onClick={() => onAlertDirectionFilterChange('SURGE')}
                >
                  急放
                </button>
                <button
                  type="button"
                  className={`seg-btn ${alertDirectionFilter === 'SHRINK' ? 'active' : ''}`}
                  onClick={() => onAlertDirectionFilterChange('SHRINK')}
                >
                  急缩
                </button>
              </div>
            </div>
          </div>

          {filteredAlerts.length === 0 ? (
            <div className="empty-state-box">
              {totalDayAlertCount === 0
                ? '当前回放参数下该交易日未触发急放/急缩告警；可展开上方「参数调优」调整斜率或倍数阈值后重新推演。'
                : `截至当前时刻（${currentTimeLabel}）暂无符合筛选条件的告警（全天共 ${totalDayAlertCount} 条），可点击「▶ 播放」或拖动时间轴查看。`}
            </div>
          ) : (
            <div className="alert-list replay-alert-list">
              {filteredAlerts.map((ev) => {
                const isSurge = ev.direction === 'SURGE';
                return (
                  <div
                    key={ev.id}
                    className={`alert-row clickable ${isSurge ? 'surge' : 'shrink'}`}
                    title={`点击定位到 ${ev.name} 的该异动分钟`}
                    onClick={() => onClickAlertItem(ev)}
                  >
                    <div className="alert-row-head">
                      <span className="alert-row-title">
                        <strong>{ev.name}</strong>{' '}
                        <span className="muted-mono">{ev.symbol}</span> ·{' '}
                        <span className={`badge ${isSurge ? 'badge-up' : 'badge-down'}`}>
                          {isSurge ? '急放量' : '急缩量'}
                        </span>
                      </span>
                      <span className="alert-row-meta">
                        {ev.tradeDate} {formatClockTime(ev.createdAt)} · 斜率{' '}
                        {formatSignedPct(ev.slope, 2)}/分 · 倍数 {ev.windowMultiple.toFixed(2)}x
                      </span>
                    </div>
                    <div className="alert-row-message">{ev.message}</div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

export interface ReplayLaunchRequest {
  symbol?: string;
  tradeDate?: string | null;
  seq: number;
}

export interface ReplayConsolePanelProps {
  monitorConfig: MonitorConfig | null;
  launchRequest: ReplayLaunchRequest | null;
  onMonitorConfigApplied: (next: MonitorConfig) => void;
}

export function ReplayConsolePanel({
  monitorConfig,
  launchRequest,
  onMonitorConfigApplied,
}: ReplayConsolePanelProps) {
  const [replayState, setReplayState] = useState<ReplaySessionState | null>(null);
  const [selectedSymbol, setSelectedSymbol] = useState<string>(
    launchRequest?.symbol || MARKET_TOTAL_SYMBOL
  );
  const [replayMuted, setReplayMuted] = useState<boolean>(true);
  const [paramsOpen, setParamsOpen] = useState<boolean>(false);
  const [paramDraft, setParamDraft] = useState<NumericParamDraftStrings | null>(null);
  const [flashAlert, setFlashAlert] = useState<AlertDispatchPayload | null>(null);
  const [applyTip, setApplyTip] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const [alertSymbolFilter, setAlertSymbolFilter] = useState<'ALL' | 'SELECTED'>('ALL');
  const [alertDirectionFilter, setAlertDirectionFilter] = useState<'ALL' | AlertDirection>('ALL');

  const selectedSymbolRef = useRef(selectedSymbol);
  const replayMutedRef = useRef(replayMuted);
  const playingRef = useRef(false);
  const handledLaunchSeqRef = useRef<number>(-1);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const applyTipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  selectedSymbolRef.current = selectedSymbol;
  replayMutedRef.current = replayMuted;

  const clearFlash = useCallback(() => {
    if (flashTimerRef.current) {
      clearTimeout(flashTimerRef.current);
      flashTimerRef.current = null;
    }
    setFlashAlert(null);
  }, []);

  const applyIncomingState = useCallback(
    (next: ReplaySessionState, syncDraft = true) => {
      playingRef.current = next.playing;
      setReplayState(next);
      if (syncDraft) {
        setParamDraft(toParamDraftStrings(next.params));
      }

      if (next.triggerReason !== 'play') {
        clearFlash();
        return;
      }

      const soundDir = resolveReplaySoundDirection(
        next,
        selectedSymbolRef.current,
        replayMutedRef.current
      );
      if (soundDir) {
        void playAlertSound(soundDir, false);
      }

      if (next.newlyTriggeredAlerts.length > 0) {
        const chosen =
          next.newlyTriggeredAlerts.find((ev) => ev.symbol === selectedSymbolRef.current) ??
          next.newlyTriggeredAlerts[0];
        if (flashTimerRef.current) {
          clearTimeout(flashTimerRef.current);
        }
        setFlashAlert(chosen);
        flashTimerRef.current = setTimeout(() => {
          setFlashAlert(null);
          flashTimerRef.current = null;
        }, 2500);
      }
    },
    [clearFlash]
  );

  // 订阅独立回放状态推送；组件卸载（切换离开复盘页签）时若正在播放则自动暂停
  useEffect(() => {
    const unsub = window.api.onReplayStateUpdated((next) => {
      applyIncomingState(next, true);
    });
    return () => {
      unsub();
      if (playingRef.current) {
        void window.api.pauseReplay().catch(() => {});
      }
      if (flashTimerRef.current) {
        clearTimeout(flashTimerRef.current);
      }
      if (applyTipTimerRef.current) {
        clearTimeout(applyTipTimerRef.current);
      }
    };
  }, [applyIncomingState]);

  // 首次挂载或响应来自「分时能量」盘后引导跳转的标的/日期请求
  useEffect(() => {
    let cancelled = false;

    const bootstrap = async () => {
      setBusy(true);
      try {
        const current = await window.api.getReplayState();
        if (cancelled) return;

        const hasNewLaunch =
          launchRequest !== null && launchRequest.seq !== handledLaunchSeqRef.current;

        if (hasNewLaunch && launchRequest) {
          handledLaunchSeqRef.current = launchRequest.seq;
          if (launchRequest.symbol) {
            setSelectedSymbol(launchRequest.symbol);
          }
          const reqDate = launchRequest.tradeDate?.trim();
          const dateExists =
            Boolean(reqDate) && current.availableDates.some((d) => d.tradeDate === reqDate);
          if (dateExists && reqDate) {
            const loaded = await window.api.loadReplayDate(reqDate);
            if (!cancelled) applyIncomingState(loaded, true);
            return;
          }
        }

        if (current.tradeDate && current.marketState) {
          applyIncomingState(current, true);
          return;
        }

        const loaded = await window.api.loadReplayDate();
        if (!cancelled) applyIncomingState(loaded, true);
      } finally {
        if (!cancelled) setBusy(false);
      }
    };

    void bootstrap();

    return () => {
      cancelled = true;
    };
  }, [applyIncomingState, launchRequest]);

  // 当前所选标的被配置/自选列表移除时安全回退至沪深两市
  useEffect(() => {
    const market = replayState?.marketState;
    if (!market || selectedSymbol === MARKET_TOTAL_SYMBOL) return;
    const exists =
      market.indices.some((i) => i.symbol === selectedSymbol) ||
      market.watchlist.some((w) => w.symbol === selectedSymbol);
    if (!exists) {
      setSelectedSymbol(MARKET_TOTAL_SYMBOL);
    }
  }, [replayState?.marketState, selectedSymbol]);

  // 键盘播控捷径（Space 播放/暂停，← / → 单步前后退）
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (
        tag === 'INPUT' ||
        tag === 'SELECT' ||
        tag === 'TEXTAREA' ||
        tag === 'BUTTON' ||
        target?.isContentEditable
      ) {
        return;
      }
      if (e.code === 'Space') {
        e.preventDefault();
        if (playingRef.current) {
          void window.api.pauseReplay().then((s) => applyIncomingState(s, false));
        } else {
          void window.api.playReplay().then((s) => applyIncomingState(s, false));
        }
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        void window.api.stepReplay(-1).then((s) => applyIncomingState(s, false));
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        void window.api.stepReplay(1).then((s) => applyIncomingState(s, false));
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [applyIncomingState]);

  const buildNumericPatchFromDraft = useCallback((): Partial<ReplayMonitorParams> => {
    const base = replayState?.params;
    if (!base || !paramDraft) return {};
    return {
      expandThresholdPct: parseFiniteOrFallback(
        paramDraft.expandThresholdPct,
        base.expandThresholdPct
      ),
      shrinkThresholdPct: parseFiniteOrFallback(
        paramDraft.shrinkThresholdPct,
        base.shrinkThresholdPct
      ),
      surgeSlopeThreshold: parseFiniteOrFallback(
        paramDraft.surgeSlopeThreshold,
        base.surgeSlopeThreshold
      ),
      surgeMultipleThreshold: parseFiniteOrFallback(
        paramDraft.surgeMultipleThreshold,
        base.surgeMultipleThreshold
      ),
      shrinkSlopeThreshold: parseFiniteOrFallback(
        paramDraft.shrinkSlopeThreshold,
        base.shrinkSlopeThreshold
      ),
      shrinkMultipleThreshold: parseFiniteOrFallback(
        paramDraft.shrinkMultipleThreshold,
        base.shrinkMultipleThreshold
      ),
      cooldownMinutes: parseFiniteOrFallback(paramDraft.cooldownMinutes, base.cooldownMinutes),
    };
  }, [paramDraft, replayState?.params]);

  const handleSelectDate = (tradeDate: string) => {
    setBusy(true);
    void window.api
      .loadReplayDate(tradeDate)
      .then((next) => applyIncomingState(next, true))
      .finally(() => setBusy(false));
  };

  const handleRefreshDates = async () => {
    setBusy(true);
    try {
      const dates = await window.api.getReplayAvailableDates();
      const curDate = replayState?.tradeDate;
      const keepCurrent = Boolean(curDate && dates.some((d) => d.tradeDate === curDate));
      const next = await window.api.loadReplayDate(keepCurrent ? curDate : undefined);
      applyIncomingState(next, true);
    } finally {
      setBusy(false);
    }
  };

  const handlePatchParams = (patch: Partial<ReplayMonitorParams>) => {
    const merged: Partial<ReplayMonitorParams> = {
      ...buildNumericPatchFromDraft(),
      ...patch,
    };
    void window.api.updateReplayParams(merged).then((next) => applyIncomingState(next, true));
  };

  const handleCommitParamDraft = () => {
    const patch = buildNumericPatchFromDraft();
    if (Object.keys(patch).length === 0) return;
    void window.api.updateReplayParams(patch).then((next) => applyIncomingState(next, true));
  };

  const handleResetParams = () => {
    void window.api.resetReplayParams().then((next) => applyIncomingState(next, true));
  };

  const handleApplyParamsToLive = async () => {
    setBusy(true);
    try {
      const draftPatch = buildNumericPatchFromDraft();
      if (Object.keys(draftPatch).length > 0) {
        await window.api.updateReplayParams(draftPatch);
      }
      const res = await window.api.applyReplayParamsToLive();
      applyIncomingState(res.replayState, true);
      onMonitorConfigApplied(res.monitorConfig);
      if (applyTipTimerRef.current) {
        clearTimeout(applyTipTimerRef.current);
      }
      setApplyTip('已应用并热生效至实盘');
      applyTipTimerRef.current = setTimeout(() => {
        setApplyTip(null);
        applyTipTimerRef.current = null;
      }, 2500);
    } finally {
      setBusy(false);
    }
  };

  const handleSeek = (targetStep: number) => {
    void window.api.seekReplay(targetStep).then((next) => applyIncomingState(next, false));
  };

  const handleClickAlertItem = (ev: AlertDispatchPayload) => {
    setSelectedSymbol(ev.symbol);
    // stepIndex 0 为 09:25 竞价锚点，minuteIndex 0..239 严格对应 stepIndex 1..240
    handleSeek(ev.minuteIndex + 1);
  };

  const effectiveParams = replayState?.params ?? (monitorConfig ? { ...monitorConfig } : null);
  const resolvedDraft =
    paramDraft ?? (effectiveParams ? toParamDraftStrings(effectiveParams) : null);

  return (
    <ReplayConsoleContent
      replayState={replayState}
      selectedSymbol={selectedSymbol}
      replayMuted={replayMuted}
      paramsOpen={paramsOpen}
      paramDraft={resolvedDraft}
      flashAlert={flashAlert}
      applyTip={applyTip}
      busy={busy}
      alertSymbolFilter={alertSymbolFilter}
      alertDirectionFilter={alertDirectionFilter}
      onSelectSymbol={setSelectedSymbol}
      onSelectDate={handleSelectDate}
      onRefreshDates={() => void handleRefreshDates()}
      onToggleMuted={() => setReplayMuted((m) => !m)}
      onToggleParamsOpen={() => setParamsOpen((o) => !o)}
      onParamFieldChange={(key, val) =>
        setParamDraft((prev) => (prev ? { ...prev, [key]: val } : prev))
      }
      onPatchParams={handlePatchParams}
      onCommitParamDraft={handleCommitParamDraft}
      onResetParams={handleResetParams}
      onApplyParamsToLive={() => void handleApplyParamsToLive()}
      onRestart={() =>
        void window.api.restartReplay().then((next) => applyIncomingState(next, false))
      }
      onStep={(delta) =>
        void window.api.stepReplay(delta).then((next) => applyIncomingState(next, false))
      }
      onTogglePlay={() => {
        if (playingRef.current) {
          void window.api.pauseReplay().then((next) => applyIncomingState(next, false));
        } else {
          void window.api.playReplay().then((next) => applyIncomingState(next, false));
        }
      }}
      onSeek={handleSeek}
      onSetSpeed={(spd) =>
        void window.api.setReplaySpeed(spd).then((next) => applyIncomingState(next, false))
      }
      onAlertSymbolFilterChange={setAlertSymbolFilter}
      onAlertDirectionFilterChange={setAlertDirectionFilter}
      onClickAlertItem={handleClickAlertItem}
    />
  );
}
