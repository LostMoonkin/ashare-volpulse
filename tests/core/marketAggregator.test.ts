import { describe, expect, it } from 'vitest';
import {
  aggregateMarketTotalAuction,
  aggregateMarketTotalSeries,
  aggregateMarketTotalSnapshot,
  type SymbolTurnoverSnapshot,
} from '../../src/core/marketAggregator';

describe('marketAggregator', () => {
  it('sums only 000001.SH and 399106.SZ and never double-counts 399001/399006/000688', () => {
    const snapshots: SymbolTurnoverSnapshot[] = [
      { symbol: '000001.SH', tradeDate: '2026-11-24', minuteIndex: 239, timestampMs: 1000, cumTurnover: 771_861_010_309 },
      { symbol: '399106.SZ', tradeDate: '2026-11-24', minuteIndex: 239, timestampMs: 1005, cumTurnover: 883_224_915_526 },
      // 下列三大指数及个股绝不可并入两市总成交额
      { symbol: '399001.SZ', tradeDate: '2026-11-24', minuteIndex: 239, timestampMs: 1005, cumTurnover: 883_224_915_526 },
      { symbol: '399006.SZ', tradeDate: '2026-11-24', minuteIndex: 239, timestampMs: 1005, cumTurnover: 448_864_158_754 },
      { symbol: '000688.SH', tradeDate: '2026-11-24', minuteIndex: 239, timestampMs: 1005, cumTurnover: 100_124_032_657 },
      { symbol: '600519.SH', tradeDate: '2026-11-24', minuteIndex: 239, timestampMs: 1005, cumTurnover: 6_214_192_454 },
    ];

    const total = aggregateMarketTotalSnapshot(snapshots);
    expect(total.degraded).toBe(false);
    expect(total.reason).toBeNull();
    expect(total.symbol).toBe('MARKET_TOTAL');
    expect(total.cumTurnover).toBe(771_861_010_309 + 883_224_915_526);
    expect(total.shTurnover).toBe(771_861_010_309);
    expect(total.szTurnover).toBe(883_224_915_526);
  });

  it('marks degraded with null total when either SH or SZ is missing or misaligned', () => {
    const missingSz = aggregateMarketTotalSnapshot([
      { symbol: '000001.SH', tradeDate: '2026-11-24', minuteIndex: 30, cumTurnover: 2e11 },
      { symbol: '399001.SZ', tradeDate: '2026-11-24', minuteIndex: 30, cumTurnover: 2.5e11 },
    ]);
    expect(missingSz.degraded).toBe(true);
    expect(missingSz.reason).toBe('MISSING_SZ');
    expect(missingSz.cumTurnover).toBeNull();

    const missingSh = aggregateMarketTotalSnapshot([
      { symbol: '399106.SZ', tradeDate: '2026-11-24', minuteIndex: 30, cumTurnover: 2.5e11 },
    ]);
    expect(missingSh.degraded).toBe(true);
    expect(missingSh.reason).toBe('MISSING_SH');
    expect(missingSh.cumTurnover).toBeNull();

    const minuteMisaligned = aggregateMarketTotalSnapshot([
      { symbol: '000001.SH', tradeDate: '2026-11-24', minuteIndex: 30, cumTurnover: 2e11 },
      { symbol: '399106.SZ', tradeDate: '2026-11-24', minuteIndex: 31, cumTurnover: 2.5e11 },
    ]);
    expect(minuteMisaligned.degraded).toBe(true);
    expect(minuteMisaligned.reason).toBe('MINUTE_MISALIGNED');
    expect(minuteMisaligned.cumTurnover).toBeNull();

    const dateMismatch = aggregateMarketTotalSnapshot([
      { symbol: '000001.SH', tradeDate: '2026-11-24', minuteIndex: 30, cumTurnover: 2e11 },
      { symbol: '399106.SZ', tradeDate: '2026-11-23', minuteIndex: 30, cumTurnover: 2.5e11 },
    ]);
    expect(dateMismatch.degraded).toBe(true);
    expect(dateMismatch.reason).toBe('TRADE_DATE_MISMATCH');
    expect(dateMismatch.cumTurnover).toBeNull();
  });

  it('aggregates aligned minute series and flags degraded on single-sided missing minutes', () => {
    const res = aggregateMarketTotalSeries(
      [
        { minuteIndex: 0, cumTurnover: 100, barTurnover: 100 },
        { minuteIndex: 1, cumTurnover: 220, barTurnover: 120 },
        { minuteIndex: 2, cumTurnover: 350, barTurnover: 130 },
      ],
      [
        { minuteIndex: 0, cumTurnover: 150, barTurnover: 150 },
        { minuteIndex: 2, cumTurnover: 450, barTurnover: 300 },
      ]
    );

    expect(res.degraded).toBe(true);
    expect(res.missingSzMinutes).toEqual([1]);
    expect(res.missingShMinutes).toEqual([]);
    expect(res.bars.map((b) => b.minuteIndex)).toEqual([0, 2]);
    expect(res.bars[0].cumTurnover).toBe(250);
    expect(res.bars[1].cumTurnover).toBe(800);
  });

  it('aggregates 09:25 auction turnover and degrades when one side is absent', () => {
    const ok = aggregateMarketTotalAuction([
      { symbol: '000001.SH', tradeDate: '2026-11-24', auctionTurnover: 12_728_771_688.5 },
      { symbol: '399106.SZ', tradeDate: '2026-11-24', auctionTurnover: 15_105_787_227.49 },
    ]);
    expect(ok.degraded).toBe(false);
    expect(ok.auctionTurnover).toBeCloseTo(27_834_558_915.99, 2);

    const partial = aggregateMarketTotalAuction([
      { symbol: '000001.SH', tradeDate: '2026-11-24', auctionTurnover: 12_728_771_688.5 },
    ]);
    expect(partial.degraded).toBe(true);
    expect(partial.auctionTurnover).toBeNull();
  });
});
