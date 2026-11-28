import { afterEach, describe, expect, it, vi } from 'vitest';
import { minuteIndexToLabel, shanghaiToTimestampMs } from '../../src/core';
import { InteractiveReplayController } from '../../src/main/replay';
import { AppDatabase } from '../../src/main/storage/database';
import { DEFAULT_MONITOR_CONFIG } from '../../src/main/storage/monitorSettingsStore';
import {
  MARKET_TOTAL_SYMBOL,
  MONITORED_INDEX_SYMBOLS,
  REPLAY_ALERT_PREFIX,
} from '../../src/shared/constants';
import type { IntradayBarRow, MonitorConfig } from '../../src/shared/types';

const openDbs: AppDatabase[] = [];

function createMemoryDb(): AppDatabase {
  const db = new AppDatabase(':memory:');
  openDbs.push(db);
  return db;
}

afterEach(() => {
  vi.useRealTimers();
  while (openDbs.length > 0) {
    openDbs.pop()?.close();
  }
});

function seedTradingDay(
  db: AppDatabase,
  tradeDate: string,
  opts?: { surgeMinuteRange?: [number, number]; omitSz?: boolean }
): void {
  const allSymbols = [...MONITORED_INDEX_SYMBOLS, '300750.SZ'];
  const bars: IntradayBarRow[] = [];

  for (const symbol of allSymbols) {
    if (opts?.omitSz && symbol === '399106.SZ') continue;
    const baseScale = symbol === '300750.SZ' ? 0.08 : 1.0;
    const auctionTurnover = 1.2e10 * baseScale;
    db.upsertAuctionSnapshot({
      symbol,
      tradeDate,
      openPrice: 3300,
      auctionTurnover,
      capturedAt: shanghaiToTimestampMs(tradeDate, 9, 25, 0),
    });

    let cum = auctionTurnover;
    for (let m = 0; m < 240; m++) {
      let mult = 1.0;
      if (opts?.surgeMinuteRange && m >= 1 && m <= 4) {
        mult = 2.8;
      }
      if (opts?.surgeMinuteRange && m >= opts.surgeMinuteRange[0] && m <= opts.surgeMinuteRange[1]) {
        const offset = m - opts.surgeMinuteRange[0] + 1;
        mult = 1 + offset * 0.4;
      }
      const barTurnover = 2.5e9 * baseScale * mult;
      cum += barTurnover;
      bars.push({
        symbol,
        tradeDate,
        minuteIndex: m,
        minuteStr: minuteIndexToLabel(m),
        price: 3300 + m * 0.15,
        cumVolume: 1_000_000 * (m + 1),
        cumTurnover: cum,
        barTurnover,
        source: 'tencent',
      });
    }
  }

  db.upsertIntradayBars(bars);
}

describe('InteractiveReplayController', () => {
  it('handles empty SQLite gracefully without throwing', () => {
    const db = createMemoryDb();
    let liveConfig: MonitorConfig = { ...DEFAULT_MONITOR_CONFIG };
    const controller = new InteractiveReplayController({
      database: db,
      getLiveMonitorConfig: () => liveConfig,
    });

    expect(controller.getAvailableDates()).toEqual([]);
    const state = controller.loadDate();
    expect(state.tradeDate).toBeNull();
    expect(state.marketState).toBeNull();
    expect(state.error).toContain('暂无已录制分钟数据');
    expect(state.playing).toBe(false);
    controller.dispose();
  });

  it('lists recorded dates with baseline flags, defaults to 15:00 on load, and keeps Seek 100% deterministic', () => {
    const db = createMemoryDb();
    db.upsertTradingDays([
      { date: '2026-11-23', isOpen: true },
      { date: '2026-11-24', isOpen: true },
      { date: '2026-11-25', isOpen: true },
    ]);
    // 2026-11-23 缺失基线（无 11-22），2026-11-24 为基线，2026-11-25 带急放脉冲
    seedTradingDay(db, '2026-11-23');
    seedTradingDay(db, '2026-11-24');
    seedTradingDay(db, '2026-11-25', { surgeMinuteRange: [40, 46] });

    const liveConfig: MonitorConfig = { ...DEFAULT_MONITOR_CONFIG };
    const controller = new InteractiveReplayController({
      database: db,
      getLiveMonitorConfig: () => liveConfig,
    });

    const dates = controller.getAvailableDates();
    expect(dates.map((d) => [d.tradeDate, d.hasPrevBaseline])).toEqual([
      ['2026-11-25', true],
      ['2026-11-24', true],
      ['2026-11-23', false],
    ]);

    // 默认选中最新有基线的交易日并直接推演至 15:00 收盘（stepIndex=240）
    const loaded = controller.loadDate();
    expect(loaded.tradeDate).toBe('2026-11-25');
    expect(loaded.prevTradeDate).toBe('2026-11-24');
    expect(loaded.stepIndex).toBe(240);
    expect(loaded.totalSteps).toBe(241);
    expect(loaded.currentTimeLabel).toBe('15:00');
    expect(loaded.finished).toBe(true);
    expect(loaded.playing).toBe(false);
    expect(loaded.triggerReason).toBe('load');
    expect(loaded.newlyTriggeredAlerts).toEqual([]);
    expect(loaded.totalDayAlertCount).toBeGreaterThan(0);
    expect(loaded.alerts.length).toBe(loaded.totalDayAlertCount);
    expect(loaded.alerts.every((a) => a.message.startsWith(REPLAY_ALERT_PREFIX))).toBe(true);

    // 验证顺序单步推进与任意 Seek 到同一帧的结果严格一致
    controller.seek(0);
    const sequentialFrames = new Map<
      number,
      { cum: number | null; slope: number | null; alertIds: number[]; len: number }
    >();
    for (let s = 0; s <= 240; s++) {
      const cur = s === 0 ? controller.seek(0) : controller.step(1);
      sequentialFrames.set(s, {
        cum: cur.marketState?.marketTotal.cumTurnover ?? null,
        slope: cur.marketState?.marketTotal.metrics?.slope ?? null,
        alertIds: cur.alerts.map((a) => a.id),
        len: cur.marketState?.marketTotal.todaySeries.length ?? 0,
      });
    }

    for (const checkStep of [240, 44, 123, 3, 45, 0]) {
      const seeked = controller.seek(checkStep);
      const expected = sequentialFrames.get(checkStep)!;
      expect(seeked.triggerReason).toBe('seek');
      expect(seeked.newlyTriggeredAlerts).toEqual([]);
      expect(seeked.marketState?.marketTotal.cumTurnover).toBe(expected.cum);
      expect(seeked.marketState?.marketTotal.metrics?.slope ?? null).toBe(expected.slope);
      expect(seeked.alerts.map((a) => a.id)).toEqual(expected.alertIds);
      expect(seeked.marketState?.marketTotal.todaySeries.length).toBe(expected.len);
    }

    // 切换到无昨日基线日期时保持显式降级，绝不补零
    const noBaseline = controller.loadDate('2026-11-23');
    expect(noBaseline.tradeDate).toBe('2026-11-23');
    expect(noBaseline.marketState?.status.degraded).toBe(true);
    expect(noBaseline.marketState?.marketTotal.degraded).toBe(true);

    // 全程绝不写入实盘 alert_events 表
    expect(db.getAlertEvents(undefined, 100)).toHaveLength(0);
    controller.dispose();
  });

  it('emits newlyTriggeredAlerts only during active playback ticks and stops at 15:00', () => {
    vi.useFakeTimers();
    const db = createMemoryDb();
    db.upsertTradingDays([
      { date: '2026-11-24', isOpen: true },
      { date: '2026-11-25', isOpen: true },
    ]);
    seedTradingDay(db, '2026-11-24');
    seedTradingDay(db, '2026-11-25', { surgeMinuteRange: [40, 46] });

    const emitted: Array<{
      stepIndex: number;
      triggerReason: string;
      newlyCount: number;
      playing: boolean;
    }> = [];
    const controller = new InteractiveReplayController({
      database: db,
      getLiveMonitorConfig: () => ({ ...DEFAULT_MONITOR_CONFIG }),
      onStateUpdate: (st) => {
        emitted.push({
          stepIndex: st.stepIndex,
          triggerReason: st.triggerReason,
          newlyCount: st.newlyTriggeredAlerts.length,
          playing: st.playing,
        });
      },
    });

    controller.loadDate('2026-11-25');
    // 在 15:00 点击播放应自动从 09:25 (step 0) 开始
    const started = controller.play();
    expect(started.stepIndex).toBe(0);
    expect(started.playing).toBe(true);
    expect(started.newlyTriggeredAlerts).toEqual([]);

    // 切为 8x 倍速（30ms/帧）并跑完全天 240 步
    const sped = controller.setSpeed(8);
    expect(sped.stepIntervalMs).toBe(30);
    vi.advanceTimersByTime(30 * 245);

    const endState = controller.getState();
    expect(endState.stepIndex).toBe(240);
    expect(endState.finished).toBe(true);
    expect(endState.playing).toBe(false);

    const playAlertEvents = emitted.filter((e) => e.triggerReason === 'play' && e.newlyCount > 0);
    expect(playAlertEvents.length).toBeGreaterThan(0);

    // Seek 到有告警的帧不会触发 newlyTriggeredAlerts（防误发声）
    const alertFrameStep = playAlertEvents[0].stepIndex;
    const seeked = controller.seek(alertFrameStep);
    expect(seeked.triggerReason).toBe('seek');
    expect(seeked.newlyTriggeredAlerts).toEqual([]);
    expect(seeked.alerts.length).toBeGreaterThan(0);

    controller.dispose();
  });

  it('supports isolated temporary parameter tuning, reset, apply-to-live, and watchlist sync without polluting live config', () => {
    const db = createMemoryDb();
    db.upsertTradingDays([
      { date: '2026-11-24', isOpen: true },
      { date: '2026-11-25', isOpen: true },
    ]);
    seedTradingDay(db, '2026-11-24');
    seedTradingDay(db, '2026-11-25', { surgeMinuteRange: [40, 46] });

    let liveConfig: MonitorConfig = { ...DEFAULT_MONITOR_CONFIG };
    const controller = new InteractiveReplayController({
      database: db,
      getLiveMonitorConfig: () => liveConfig,
    });

    const baselineState = controller.loadDate('2026-11-25');
    const baselineAlertCount = baselineState.totalDayAlertCount;
    expect(baselineAlertCount).toBeGreaterThan(0);
    expect(baselineState.isCustomParams).toBe(false);

    // 调高急放阈值使推演告警归零；实盘 liveConfig 绝不被改变
    const strictState = controller.updateParams({
      surgeSlopeThreshold: 45,
      surgeMultipleThreshold: 10,
    });
    expect(strictState.isCustomParams).toBe(true);
    expect(strictState.totalDayAlertCount).toBe(0);
    expect(strictState.newlyTriggeredAlerts).toEqual([]);
    expect(liveConfig.surgeSlopeThreshold).toBe(DEFAULT_MONITOR_CONFIG.surgeSlopeThreshold);

    // 关闭告警总开关同样即时生效
    const disabledState = controller.updateParams({ alertsEnabled: false });
    expect(disabledState.totalDayAlertCount).toBe(0);

    // 重置回实盘配置后恢复原始告警数
    const resetState = controller.resetParams();
    expect(resetState.isCustomParams).toBe(false);
    expect(resetState.totalDayAlertCount).toBe(baselineAlertCount);

    // 自定义为 OR 模式后应用至实盘
    const orState = controller.updateParams({
      matchMode: 'OR',
      surgeSlopeThreshold: 1.5,
    });
    expect(orState.isCustomParams).toBe(true);
    liveConfig = { ...liveConfig, ...controller.getEffectiveParams() };
    const appliedState = controller.markAppliedToLive(liveConfig);
    expect(appliedState.isCustomParams).toBe(false);
    expect(appliedState.params.matchMode).toBe('OR');

    // 新增自选股后同步重演应纳入自选股行情
    db.upsertWatchlistItem({
      symbol: '300750.SZ',
      name: '宁德时代',
      sortOrder: 0,
      alertEnabled: true,
      customThresholdsJson: null,
    });
    controller.syncWatchlistChanged();
    const afterWl = controller.getState();
    expect(afterWl.marketState?.watchlist.map((w) => w.symbol)).toEqual(['300750.SZ']);
    expect(afterWl.marketState?.marketTotal.symbol).toBe(MARKET_TOTAL_SYMBOL);
    expect(db.getAlertEvents(undefined, 100)).toHaveLength(0);

    controller.dispose();
  });
});
