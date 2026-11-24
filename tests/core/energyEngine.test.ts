import { describe, expect, it } from 'vitest';
import {
  computeOlsSlope,
  evaluateEnergy,
  type MinuteTurnoverPoint,
} from '../../src/core/energyEngine';

describe('energyEngine', () => {
  it('matches hand-calculated ΔA, R, predicted full-day turnover, OLS slope S_W, and multiple M_W', () => {
    // 构造 0..10 分钟（共 11 根）：
    // 昨日每分钟匀速成交 100 亿：prev(k) = (k + 1) * 100
    // 今日在第 0..5 分钟同比均为 0%；第 6..10 分钟同比精确线性递增 +2%/min：
    //   R(6)=+2%, R(7)=+4%, R(8)=+6%, R(9)=+8%, R(10)=+10%
    const prevSeries: MinuteTurnoverPoint[] = [];
    const todaySeries: MinuteTurnoverPoint[] = [];
    const ratiosPct = [0, 0, 0, 0, 0, 0, 2, 4, 6, 8, 10];

    for (let k = 0; k <= 10; k++) {
      const prevCum = (k + 1) * 100;
      const todayCum = prevCum * (1 + ratiosPct[k] / 100);
      prevSeries.push({ minuteIndex: k, cumTurnover: prevCum });
      todaySeries.push({ minuteIndex: k, cumTurnover: todayCum });
    }

    // t = 10, W = 5:
    //   A_prev(10) = 1100, A_today(10) = 1210
    //   ΔA = +110, R = +0.10 (+10%), predicted = 24000 * (1210/1100) = 26400
    //   S_5(10) 对 {(6,2), (7,4), (8,6), (9,8), (10,10)} 做 OLS → 精确斜率 = +2.0 %/min
    //   M_5(10) = (A_today(10) - A_today(5)) / (A_prev(10) - A_prev(5))
    //           = (1210 - 600) / (1100 - 600) = 610 / 500 = 1.22x
    const m = evaluateEnergy({
      todaySeries,
      prevSeries,
      minuteIndex: 10,
      elapsedSeconds: 60,
      prevFullDayTurnover: 24_000,
    });

    expect(m.cumDiff).toBeCloseTo(110, 6);
    expect(m.cumRatio).toBeCloseTo(0.1, 6);
    expect(m.cumRatioPct).toBeCloseTo(10, 6);
    expect(m.predictedFullDayTurnover).toBeCloseTo(26_400, 6);
    expect(m.volumeState).toBe('EXPANDING');
    expect(m.slope).toBeCloseTo(2.0, 6);
    expect(m.windowMultiple).toBeCloseTo(1.22, 6);
  });

  it('classifies exact ±5% thresholds into EXPANDING / FLAT / SHRINKING correctly', () => {
    const prev: MinuteTurnoverPoint[] = [{ minuteIndex: 10, cumTurnover: 1000 }];

    const check = (todayVal: number) =>
      evaluateEnergy({
        todaySeries: [{ minuteIndex: 10, cumTurnover: todayVal }],
        prevSeries: prev,
        minuteIndex: 10,
      }).volumeState;

    expect(check(1050)).toBe('EXPANDING'); // +5.0%
    expect(check(1049.9)).toBe('FLAT'); // +4.99%
    expect(check(950.1)).toBe('FLAT'); // -4.99%
    expect(check(950)).toBe('SHRINKING'); // -5.0%
  });

  it('prevents false shrink alert at 10 seconds into an unclosed minute via linear interpolation', () => {
    // 昨日：第 9 分钟累计 1000，第 10 分钟累计 1600（单分钟增量 600）
    // 今日：第 9 分钟累计 1000，第 10 分钟刚过去 10 秒，按与昨日相同速率成交了 100，此时累计 1100
    // 若不插值：1100 vs 1600 = -31.25%（严重误判骤缩！）
    // 线性插值：A_prev_aligned = 1000 + (10/60) * 600 = 1100 → R(10) = 0% (FLAT)
    const prevSeries: MinuteTurnoverPoint[] = [
      { minuteIndex: 9, cumTurnover: 1000 },
      { minuteIndex: 10, cumTurnover: 1600 },
    ];
    const todaySeries: MinuteTurnoverPoint[] = [{ minuteIndex: 9, cumTurnover: 1000 }];

    const metrics = evaluateEnergy({
      todaySeries,
      prevSeries,
      minuteIndex: 10,
      currentTodayCumTurnover: 1100,
      elapsedSeconds: 10,
    });

    expect(metrics.prevAlignedCumTurnover).toBeCloseTo(1100, 6);
    expect(metrics.cumDiff).toBeCloseTo(0, 6);
    expect(metrics.cumRatioPct).toBeCloseTo(0, 6);
    expect(metrics.volumeState).toBe('FLAT');
  });

  it('keeps rolling slope continuous across lunch break (11:28 -> 13:02)', () => {
    // minuteIndex 117(11:27) .. 122(13:02)，午休 11:30-13:00 完全折叠
    // 窗口 W=5 在 t=122(13:02) 上取 [118, 119, 120, 121, 122]（11:28, 11:29, 13:00, 13:01, 13:02）
    const prevSeries: MinuteTurnoverPoint[] = [];
    const todaySeries: MinuteTurnoverPoint[] = [];
    const ratiosByIndex: Record<number, number> = {
      117: 0,
      118: 1.5,
      119: 3.0,
      120: 4.5,
      121: 6.0,
      122: 7.5,
    };

    for (let k = 117; k <= 122; k++) {
      const prevCum = 10_000 + (k - 117) * 500;
      const todayCum = prevCum * (1 + ratiosByIndex[k] / 100);
      prevSeries.push({ minuteIndex: k, cumTurnover: prevCum });
      todaySeries.push({ minuteIndex: k, cumTurnover: todayCum });
    }

    const metrics = evaluateEnergy({
      todaySeries,
      prevSeries,
      minuteIndex: 122,
      elapsedSeconds: 60,
    });

    // 连续 5 个点线性递增 +1.5%/min，午休完全折叠，斜率应精确为 +1.5
    expect(metrics.slope).toBeCloseTo(1.5, 6);
    // M_5(122) = (today(122) - today(117)) / (prev(122) - prev(117))
    //          = (12500 * 1.075 - 10000) / (12500 - 10000) = 3437.5 / 2500 = 1.375
    expect(metrics.windowMultiple).toBeCloseTo(1.375, 6);
  });

  it('returns unavailable/null without zero-filling when prev baseline is missing, zero, or denominator <= 0', () => {
    // 1. 昨日同期完全缺失
    const missingPrev = evaluateEnergy({
      todaySeries: [{ minuteIndex: 10, cumTurnover: 500 }],
      prevSeries: [],
      minuteIndex: 10,
      prevFullDayTurnover: 10_000,
    });
    expect(missingPrev.cumDiff).toBeNull();
    expect(missingPrev.cumRatio).toBeNull();
    expect(missingPrev.predictedFullDayTurnover).toBeNull();
    expect(missingPrev.volumeState).toBe('UNAVAILABLE');
    expect(missingPrev.slope).toBeNull();
    expect(missingPrev.windowMultiple).toBeNull();

    // 2. 昨日同期为 0
    const zeroPrev = evaluateEnergy({
      todaySeries: [{ minuteIndex: 10, cumTurnover: 500 }],
      prevSeries: [{ minuteIndex: 10, cumTurnover: 0 }],
      minuteIndex: 10,
    });
    expect(zeroPrev.cumRatio).toBeNull();
    expect(zeroPrev.volumeState).toBe('UNAVAILABLE');

    // 3. 昨日区间增量为 0（停牌/无成交），分母 <= 0 → windowMultiple 不可用；无 prevFullDayTurnover → 预测为 null
    const flatPrev = evaluateEnergy({
      todaySeries: [
        { minuteIndex: 5, cumTurnover: 100 },
        { minuteIndex: 6, cumTurnover: 110 },
        { minuteIndex: 7, cumTurnover: 120 },
        { minuteIndex: 8, cumTurnover: 130 },
        { minuteIndex: 9, cumTurnover: 140 },
        { minuteIndex: 10, cumTurnover: 150 },
      ],
      prevSeries: [
        { minuteIndex: 5, cumTurnover: 100 },
        { minuteIndex: 6, cumTurnover: 100 },
        { minuteIndex: 7, cumTurnover: 100 },
        { minuteIndex: 8, cumTurnover: 100 },
        { minuteIndex: 9, cumTurnover: 100 },
        { minuteIndex: 10, cumTurnover: 100 },
      ],
      minuteIndex: 10,
      prevFullDayTurnover: null,
    });
    expect(flatPrev.predictedFullDayTurnover).toBeNull();
    expect(flatPrev.windowMultiple).toBeNull();
    expect(flatPrev.slope).toBeCloseTo(10, 6);

    // 4. OLS 少于 2 点返回 null
    expect(computeOlsSlope([[0, 1]])).toBeNull();
  });
});
