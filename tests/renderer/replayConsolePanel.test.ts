import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  ReplayConsoleContent,
  resolveReplayKeyboardAction,
  resolveReplayLaunchBehavior,
  resolveReplaySoundDirection,
  shouldShowPostCloseReplayGuide,
  shouldSyncReplayParamDraft,
  type ReplayConsoleContentProps,
} from '../../src/renderer/src/detail/ReplayConsolePanel';
import { MARKET_TOTAL_SYMBOL, REPLAY_ALERT_PREFIX } from '../../src/shared/constants';
import type {
  AlertDispatchPayload,
  MarketDashboardState,
  ReplaySessionState,
} from '../../src/shared/types';

function makeReplayAlert(overrides?: Partial<AlertDispatchPayload>): AlertDispatchPayload {
  return {
    id: -1,
    symbol: MARKET_TOTAL_SYMBOL,
    name: '沪深两市',
    tradeDate: '2026-11-25',
    minuteIndex: 42,
    direction: 'SURGE',
    slope: 4.52,
    windowMultiple: 1.92,
    cumRatio: 0.16,
    message: `${REPLAY_ALERT_PREFIX} 沪深两市 5m 斜率 +4.52%/分`,
    createdAt: Date.parse('2026-11-25T02:12:59.000Z'),
    isRead: false,
    isSimulated: false,
    isReplay: true,
    muted: true,
    ...overrides,
  };
}

function makeDashboardState(overrides?: Partial<MarketDashboardState['status']>): MarketDashboardState {
  return {
    status: {
      mode: 'REPLAY',
      phase: 'POST_MARKET',
      tradeDate: '2026-11-25',
      prevTradeDate: '2026-11-24',
      activeSnapshotProvider: null,
      activeIntradayProvider: 'tencent',
      calendarSource: 'sqlite_cache',
      calendarDegraded: false,
      pollingIntervalSec: 3,
      configuredIntervalSec: 3,
      lastUpdatedAt: Date.parse('2026-11-25T07:00:00.000Z'),
      lastLatencyMs: 0,
      consecutiveFailures: 0,
      stale: false,
      degraded: false,
      degradedReasons: [],
      ...overrides,
    },
    marketTotal: {
      symbol: MARKET_TOTAL_SYMBOL,
      name: '沪深两市',
      tradeDate: '2026-11-25',
      prevTradeDate: '2026-11-24',
      cumTurnover: 1.68e12,
      shTurnover: 7.2e11,
      szTurnover: 9.6e11,
      auctionTurnover: 1.8e10,
      prevAuctionTurnover: 1.5e10,
      prevFullDayTurnover: 1.48e12,
      metrics: {
        minuteIndex: 239,
        elapsedSeconds: 60,
        todayCumTurnover: 1.68e12,
        prevAlignedCumTurnover: 1.48e12,
        cumDiff: 2e11,
        cumRatio: 0.135,
        cumRatioPct: 13.5,
        predictedFullDayTurnover: 1.68e12,
        volumeState: 'EXPANDING',
        slope: 0.85,
        windowMultiple: 1.18,
        windowDeviationPct: 18,
        slopeWindow: 5,
      },
      todaySeries: [],
      prevSeries: [],
      degraded: false,
      degradedReason: null,
    },
    indices: [
      {
        symbol: '000001.SH',
        name: '上证指数',
        isIndex: true,
        scope: '全市场',
        quote: {
          symbol: '000001.SH',
          name: '上证指数',
          price: 3320.15,
          prevClose: 3300,
          open: 3305,
          high: 3330,
          low: 3298,
          changeAmt: 20.15,
          changePct: 0.61,
          volumeShares: 100000,
          turnover: 7.2e11,
          tradeDate: '2026-11-25',
          timestampMs: Date.now(),
          source: 'tencent',
        },
        metrics: null,
        auctionTurnover: 8e9,
        prevAuctionTurnover: 7e9,
        prevFullDayTurnover: 6.4e11,
        todaySeries: [],
        prevSeries: [],
        degraded: false,
        degradedReason: null,
      },
    ],
    watchlist: [],
    recentAlerts: [],
  };
}

function makeReplayState(overrides?: Partial<ReplaySessionState>): ReplaySessionState {
  const alert = makeReplayAlert();
  return {
    availableDates: [
      {
        tradeDate: '2026-11-25',
        prevTradeDate: '2026-11-24',
        hasPrevBaseline: true,
        shBarCount: 240,
        szBarCount: 240,
      },
      {
        tradeDate: '2026-11-24',
        prevTradeDate: null,
        hasPrevBaseline: false,
        shBarCount: 240,
        szBarCount: 240,
      },
    ],
    tradeDate: '2026-11-25',
    prevTradeDate: '2026-11-24',
    stepIndex: 240,
    totalSteps: 241,
    currentTimeLabel: '15:00',
    playing: false,
    speed: 2,
    stepIntervalMs: 120,
    finished: true,
    triggerReason: 'load',
    params: {
      expandThresholdPct: 5,
      shrinkThresholdPct: -5,
      slopeWindow: 5,
      alertsEnabled: true,
      surgeSlopeThreshold: 3.0,
      surgeMultipleThreshold: 1.5,
      shrinkSlopeThreshold: -3.0,
      shrinkMultipleThreshold: 0.65,
      matchMode: 'AND',
      cooldownMinutes: 5,
    },
    isCustomParams: false,
    marketState: makeDashboardState(),
    alerts: [alert],
    newlyTriggeredAlerts: [],
    totalDayAlertCount: 1,
    alertCountBySymbol: { [MARKET_TOTAL_SYMBOL]: 1 },
    error: null,
    ...overrides,
  };
}

function renderConsole(overrides?: Partial<ReplayConsoleContentProps>): string {
  const st = makeReplayState();
  const props: ReplayConsoleContentProps = {
    replayState: st,
    selectedSymbol: MARKET_TOTAL_SYMBOL,
    replayMuted: true,
    paramsOpen: false,
    paramDraft: {
      expandThresholdPct: String(st.params.expandThresholdPct),
      shrinkThresholdPct: String(st.params.shrinkThresholdPct),
      surgeSlopeThreshold: String(st.params.surgeSlopeThreshold),
      surgeMultipleThreshold: String(st.params.surgeMultipleThreshold),
      shrinkSlopeThreshold: String(st.params.shrinkSlopeThreshold),
      shrinkMultipleThreshold: String(st.params.shrinkMultipleThreshold),
      cooldownMinutes: String(st.params.cooldownMinutes),
    },
    flashAlert: null,
    applyTip: null,
    busy: false,
    alertSymbolFilter: 'ALL',
    alertDirectionFilter: 'ALL',
    onSelectSymbol: vi.fn(),
    onSelectDate: vi.fn(),
    onRefreshDates: vi.fn(),
    onToggleMuted: vi.fn(),
    onToggleParamsOpen: vi.fn(),
    onParamFieldChange: vi.fn(),
    onPatchParams: vi.fn(),
    onCommitParamDraft: vi.fn(),
    onResetParams: vi.fn(),
    onApplyParamsToLive: vi.fn(),
    onRestart: vi.fn(),
    onStep: vi.fn(),
    onTogglePlay: vi.fn(),
    onSeek: vi.fn(),
    onSetSpeed: vi.fn(),
    onAlertSymbolFilterChange: vi.fn(),
    onAlertDirectionFilterChange: vi.fn(),
    onClickAlertItem: vi.fn(),
    ...overrides,
  };
  return renderToStaticMarkup(createElement(ReplayConsoleContent, props));
}

describe('ReplayConsolePanel helpers and UI', () => {
  it('resolves replay sound trigger strictly for unmuted dynamic play steps', () => {
    const surge = makeReplayAlert({ symbol: MARKET_TOTAL_SYMBOL, direction: 'SURGE' });
    const shrink = makeReplayAlert({ id: -2, symbol: '300750.SZ', direction: 'SHRINK' });

    // 静音时绝不发声
    expect(
      resolveReplaySoundDirection(
        { triggerReason: 'play', newlyTriggeredAlerts: [surge] },
        MARKET_TOTAL_SYMBOL,
        true
      )
    ).toBeNull();

    // Seek / Load / Step / Recompute 绝不发声
    for (const reason of ['init', 'load', 'seek', 'step', 'recompute'] as const) {
      expect(
        resolveReplaySoundDirection(
          { triggerReason: reason, newlyTriggeredAlerts: [surge] },
          MARKET_TOTAL_SYMBOL,
          false
        )
      ).toBeNull();
    }

    // 仅动态 play 且非静音且有新告警才发声，并优先匹配当前选中标的
    expect(
      resolveReplaySoundDirection(
        { triggerReason: 'play', newlyTriggeredAlerts: [surge, shrink] },
        '300750.SZ',
        false
      )
    ).toBe('SHRINK');
  });

  it('determines post-close empty-alert guide banner visibility accurately (excluding LUNCH_BREAK)', () => {
    const postMarket = makeDashboardState({ mode: 'REPLAY', phase: 'POST_MARKET' });
    const lunchBreak = makeDashboardState({ mode: 'REPLAY', phase: 'LUNCH_BREAK' });
    const liveMorning = makeDashboardState({ mode: 'LIVE', phase: 'MORNING_SESSION' });

    expect(
      shouldShowPostCloseReplayGuide({
        market: postMarket,
        isCliReplay: false,
        todayAlertsCount: 0,
        alertsReady: true,
      })
    ).toBe(true);

    expect(
      shouldShowPostCloseReplayGuide({
        market: lunchBreak,
        isCliReplay: false,
        todayAlertsCount: 0,
        alertsReady: true,
      })
    ).toBe(false);

    expect(
      shouldShowPostCloseReplayGuide({
        market: postMarket,
        isCliReplay: false,
        todayAlertsCount: 2,
        alertsReady: true,
      })
    ).toBe(false);

    expect(
      shouldShowPostCloseReplayGuide({
        market: liveMorning,
        isCliReplay: false,
        todayAlertsCount: 0,
        alertsReady: true,
      })
    ).toBe(false);

    expect(
      shouldShowPostCloseReplayGuide({
        market: postMarket,
        isCliReplay: true,
        todayAlertsCount: 0,
        alertsReady: true,
      })
    ).toBe(false);
  });

  it('prevents play ticks from overwriting paramDraft, consumes launchRequest once, handles shortcuts cleanly, and shows 09:25 single-symbol auction turnover', () => {
    const st = makeReplayState();

    // 1. 播放帧 params 未变时绝不覆盖用户正在输入的草稿；仅真实变化或 forceSync=true 时同步
    expect(shouldSyncReplayParamDraft(null, st.params)).toBe(true);
    expect(shouldSyncReplayParamDraft(st.params, { ...st.params })).toBe(false);
    expect(
      shouldSyncReplayParamDraft(st.params, { ...st.params, surgeSlopeThreshold: 4.2 })
    ).toBe(true);
    expect(shouldSyncReplayParamDraft(st.params, { ...st.params }, true)).toBe(true);

    // 2. launchRequest 消费并清空后，切页签重挂载应保持用户当前已切换日期而不被旧请求覆盖
    const firstMount = resolveReplayLaunchBehavior(
      {
        availableDates: st.availableDates,
        tradeDate: '2026-11-24',
        marketState: st.marketState,
      },
      { symbol: '000001.SH', tradeDate: '2026-11-25', seq: 1 },
      -1
    );
    expect(firstMount).toEqual({
      mode: 'load_date',
      tradeDate: '2026-11-25',
      symbol: '000001.SH',
      consumedSeq: 1,
    });
    const remountAfterCleared = resolveReplayLaunchBehavior(
      {
        availableDates: st.availableDates,
        tradeDate: '2026-11-24',
        marketState: st.marketState,
      },
      null,
      -1
    );
    expect(remountAfterCleared).toEqual({ mode: 'use_current' });

    // 3. 按钮获焦后 ←/→ 仍可用；Space 在按钮上让位给按钮激活，在输入控件上屏蔽全部快捷键
    expect(resolveReplayKeyboardAction({ key: 'ArrowLeft', code: 'ArrowLeft', targetTag: 'BUTTON' })).toBe(
      'step_back'
    );
    expect(resolveReplayKeyboardAction({ key: 'ArrowRight', code: 'ArrowRight', targetTag: 'BUTTON' })).toBe(
      'step_forward'
    );
    expect(resolveReplayKeyboardAction({ key: ' ', code: 'Space', targetTag: 'BUTTON' })).toBeNull();
    expect(resolveReplayKeyboardAction({ key: ' ', code: 'Space', targetTag: 'DIV' })).toBe(
      'toggle_play'
    );
    expect(resolveReplayKeyboardAction({ key: 'ArrowLeft', code: 'ArrowLeft', targetTag: 'INPUT' })).toBeNull();

    // 4. 第 0 步 (09:25) 选中单只指数时，成交额回退展示 09:25 竞价成交额而非「降级/无数据」
    const step0State = makeReplayState({
      stepIndex: 0,
      currentTimeLabel: '09:25',
      finished: false,
      marketState: {
        ...makeDashboardState({ phase: 'OPEN_AUCTION' }),
        indices: [
          {
            symbol: '000001.SH',
            name: '上证指数',
            isIndex: true,
            scope: '全市场',
            quote: null,
            metrics: null,
            auctionTurnover: 8.5e9,
            prevAuctionTurnover: 7.1e9,
            prevFullDayTurnover: 6.4e11,
            todaySeries: [],
            prevSeries: [],
            degraded: false,
            degradedReason: null,
          },
        ],
      },
    });
    const step0Html = renderConsole({
      replayState: step0State,
      selectedSymbol: '000001.SH',
    });
    expect(step0Html).toContain('85.0 亿');
    expect(step0Html).not.toContain('降级/无数据');
  });

  it('renders transport bar, date selector, mute button, tuning drawer, and replay alerts', () => {
    const html = renderConsole({ paramsOpen: true });

    expect(html).toContain('2026-11-25 (基线 2026-11-24)');
    expect(html).toContain('2026-11-24 (无昨日基线 · 降级)');
    expect(html).toContain('🔇 回放静音');
    expect(html).toContain('⏮ 从头播放');
    expect(html).toContain('◀ -1m');
    expect(html).toContain('▶ +1m');
    expect(html).toContain('⏭ 15:00');
    expect(html).toContain('1x');
    expect(html).toContain('2x');
    expect(html).toContain('4x');
    expect(html).toContain('8x');
    expect(html).toContain('aria-label="回放时间轴"');
    expect(html).toContain('回放独立告警参数');
    expect(html).toContain('重置为实盘配置');
    expect(html).toContain('应用为实盘配置');
    expect(html).toContain('[回放] 沪深两市');
  });

  it('renders error empty state cleanly when no recorded dates exist', () => {
    const emptyState = makeReplayState({
      availableDates: [],
      tradeDate: null,
      prevTradeDate: null,
      stepIndex: 0,
      totalSteps: 0,
      currentTimeLabel: '--:--',
      marketState: null,
      alerts: [],
      totalDayAlertCount: 0,
      error: '本地 SQLite 暂无已录制分钟数据',
    });

    const html = renderConsole({ replayState: emptyState });
    expect(html).toContain('暂无可用回放数据');
    expect(html).toContain('本地 SQLite 暂无已录制分钟数据');
  });
});
