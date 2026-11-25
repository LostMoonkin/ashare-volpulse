import { describe, expect, it } from 'vitest';
import {
  buildEnergyChartDataset,
  CHART_SLOT_COUNT,
  LUNCH_DIVIDER_SLOT,
} from '../../src/shared/chartData';
import { MARKET_TOTAL_SYMBOL, SIMULATED_ALERT_PREFIX } from '../../src/shared/constants';
import type { AlertEventRow, IntradayBarRow, MarketDashboardState } from '../../src/shared/types';

function makeIndexBars(symbol: string, tradeDate: string, scale: number): IntradayBarRow[] {
  const bars: IntradayBarRow[] = [];
  let cum = 1e9 * scale;
  for (let m = 0; m < 126; m++) {
    // 跨越上午末段 11:29 (119) 到下午开盘 13:00 (120)
    const barTurn = 2e8 * scale * (1 + m * 0.002);
    cum += barTurn;
    bars.push({
      symbol,
      tradeDate,
      minuteIndex: m,
      minuteStr: m < 120 ? '11:29' : '13:00',
      price: 3300 + m * 0.5,
      cumVolume: 1_000_000 * (m + 1),
      cumTurnover: cum,
      barTurnover: barTurn,
      source: 'tencent',
    });
  }
  return bars;
}

function makeDashboard(): MarketDashboardState {
  const todayBars = makeIndexBars('000001.SH', '2026-11-25', 1.25);
  const prevBars = makeIndexBars('000001.SH', '2026-11-24', 1.0);

  return {
    status: {
      mode: 'LIVE',
      phase: 'AFTERNOON_SESSION',
      tradeDate: '2026-11-25',
      prevTradeDate: '2026-11-24',
      activeSnapshotProvider: 'tencent',
      activeIntradayProvider: 'tencent',
      calendarSource: 'sqlite_cache',
      calendarDegraded: false,
      pollingIntervalSec: 3,
      configuredIntervalSec: 3,
      lastUpdatedAt: Date.now(),
      lastLatencyMs: 45,
      consecutiveFailures: 0,
      stale: false,
      degraded: false,
      degradedReasons: [],
    },
    marketTotal: {
      symbol: MARKET_TOTAL_SYMBOL,
      name: '沪深两市',
      tradeDate: '2026-11-25',
      prevTradeDate: '2026-11-24',
      cumTurnover: todayBars[todayBars.length - 1].cumTurnover * 2.1,
      shTurnover: todayBars[todayBars.length - 1].cumTurnover,
      szTurnover: todayBars[todayBars.length - 1].cumTurnover * 1.1,
      auctionTurnover: 1.5e10,
      prevAuctionTurnover: 1.2e10,
      prevFullDayTurnover: 1.5e12,
      metrics: null,
      todaySeries: todayBars.map((b) => ({
        minuteIndex: b.minuteIndex,
        cumTurnover: b.cumTurnover * 2.1,
        barTurnover: b.barTurnover * 2.1,
      })),
      prevSeries: prevBars.map((b) => ({
        minuteIndex: b.minuteIndex,
        cumTurnover: b.cumTurnover * 2.1,
        barTurnover: b.barTurnover * 2.1,
      })),
      degraded: false,
      degradedReason: null,
    },
    indices: [
      {
        symbol: '000001.SH',
        name: '上证指数',
        isIndex: true,
        scope: '全市场',
        quote: null,
        metrics: null,
        auctionTurnover: 7e9,
        prevAuctionTurnover: 6e9,
        prevFullDayTurnover: 7e11,
        todaySeries: todayBars,
        prevSeries: prevBars,
        degraded: false,
        degradedReason: null,
      },
    ],
    watchlist: [],
    recentAlerts: [],
  };
}

describe('buildEnergyChartDataset', () => {
  it('folds lunch break cleanly, keeps 09:25 auction anchor isolated, and computes slope + alert markers', () => {
    const market = makeDashboard();
    const alerts: AlertEventRow[] = [
      {
        id: 1,
        symbol: MARKET_TOTAL_SYMBOL,
        name: '沪深两市',
        tradeDate: '2026-11-25',
        minuteIndex: 122,
        direction: 'SURGE',
        slope: 1.55,
        windowMultiple: 1.72,
        cumRatio: 0.25,
        message: `${SIMULATED_ALERT_PREFIX} 快速放量测试`,
        createdAt: Date.now(),
      },
      {
        id: 2,
        symbol: '000001.SH',
        name: '上证指数',
        tradeDate: '2026-11-25',
        minuteIndex: 60,
        direction: 'SHRINK',
        slope: -1.4,
        windowMultiple: 0.58,
        cumRatio: -0.1,
        message: '上证指数快速缩量',
        createdAt: Date.now(),
      },
    ];

    const dataset = buildEnergyChartDataset({
      market,
      symbol: MARKET_TOTAL_SYMBOL,
      alerts,
      slopeWindow: 5,
    });

    // 241 个槽位：09:25 + 240 连续分钟，午休折叠在槽位 120(11:29) -> 121(13:00)
    expect(dataset.xLabels).toHaveLength(CHART_SLOT_COUNT);
    expect(dataset.xLabels[0]).toBe('09:25');
    expect(dataset.xLabels[1]).toBe('09:30');
    expect(dataset.xLabels[120]).toBe('11:29');
    expect(dataset.xLabels[LUNCH_DIVIDER_SLOT]).toBe('13:00');
    expect(dataset.xLabels[240]).toBe('14:59');

    // 09:25 竞价锚点独立展示，不混入 1m 增量、边际量比与斜率
    expect(dataset.todayCum[0]).toBe(1.5e10);
    expect(dataset.prevCum[0]).toBe(1.2e10);
    expect(dataset.todayBar[0]).toBeNull();
    expect(dataset.marginalDevSeries[0]).toBeNull();
    expect(dataset.slopeSeries[0]).toBeNull();

    // 跨午休 13:02 (minuteIndex 122 -> slot 123) 连续计算出有效边际量比与斜率，且未来未发生分钟保持 null（绝不补零）
    expect(dataset.marginalDevSeries[123]).toBeCloseTo(25.0, 4);
    expect(dataset.slopeSeries[123]).not.toBeNull();
    expect(dataset.todayCum[200]).toBeNull();
    expect(dataset.todayBar[200]).toBeNull();

    // 大盘总成交额自动叠加「上证点位」作为右轴价格参照
    expect(dataset.priceSeriesName).toBe('上证点位');
    expect(dataset.priceSeries[120]).toBeGreaterThan(3000);

    // 仅映射当前标的的告警散点，纵坐标落于边际量比趋势线上
    expect(dataset.alertMarkers).toHaveLength(1);
    expect(dataset.alertMarkers[0].slotIndex).toBe(123);
    expect(dataset.alertMarkers[0].marginalDevPct).toBeCloseTo(25.0, 4);
    expect(dataset.alertMarkers[0].isSimulated).toBe(true);
  });

  it('marks dataset degraded without zero-filling when market data is missing', () => {
    const empty = buildEnergyChartDataset({
      market: null,
      symbol: '300750.SZ',
      alerts: [],
    });
    expect(empty.hasData).toBe(false);
    expect(empty.degraded).toBe(true);
    expect(empty.todayCum.every((v) => v === null)).toBe(true);
  });
});
