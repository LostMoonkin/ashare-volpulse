import { describe, expect, it } from 'vitest';
import {
  computeOlsSlope,
  evaluateEnergy,
  type MinuteTurnoverPoint,
} from '../../src/core/energyEngine';

describe('energyEngine', () => {
  it('matches hand-calculated ΔA, R, predicted full-day turnover, marginal deviation D_W, OLS slope S_W, and multiple M_W', () => {
    // 构造 0..10 分钟（共 11 根）：
    // 昨日每分钟匀速成交 100 亿：prev(k) = (k + 1) * 100
    // 今日 0..5 分钟匀速 100；6..10 分钟边际逐分钟递增：
    //   bar(6)=110, bar(7)=120, bar(8)=130, bar(9)=140, bar(10)=150
    // 则 W=5 时最近 5 分钟边际量比偏离 D_5(k) = ((today(k)-today(k-5))/500 - 1)*100：
    //   D_5(6)  = (510/500 - 1)*100 = +2%
    //   D_5(7)  = (530/500 - 1)*100 = +6%
    //   D_5(8)  = (560/500 - 1)*100 = +12%
    //   D_5(9)  = (600/500 - 1)*100 = +20%
    //   D_5(10) = (650/500 - 1)*100 = +30%
    const prevSeries: MinuteTurnoverPoint[] = [];
    const todaySeries: MinuteTurnoverPoint[] = [];
    const todayBars = [100, 100, 100, 100, 100, 100, 110, 120, 130, 140, 150];

    let todayCum = 0;
    for (let k = 0; k <= 10; k++) {
      const prevCum = (k + 1) * 100;
      todayCum += todayBars[k];
      prevSeries.push({ minuteIndex: k, cumTurnover: prevCum });
      todaySeries.push({ minuteIndex: k, cumTurnover: todayCum });
    }

    // t = 10, W = 5:
    //   A_prev(10) = 1100, A_today(10) = 1250, ΔA = +150, R = +150/1100
    //   M_5(10) = (1250 - 600) / (1100 - 600) = 650 / 500 = 1.30x
    //   D_5(10) = +30%
    //   S_5(10) = OLS([(6,2), (7,6), (8,12), (9,20), (10,30)]) = +7.0 %/min
    const m = evaluateEnergy({
      todaySeries,
      prevSeries,
      minuteIndex: 10,
      elapsedSeconds: 60,
      prevFullDayTurnover: 24_000,
    });

    expect(m.cumDiff).toBeCloseTo(150, 6);
    expect(m.cumRatio).toBeCloseTo(150 / 1100, 6);
    expect(m.cumRatioPct).toBeCloseTo((150 / 1100) * 100, 6);
    expect(m.predictedFullDayTurnover).toBeCloseTo(24_000 * (1250 / 1100), 6);
    expect(m.volumeState).toBe('EXPANDING');
    expect(m.windowMultiple).toBeCloseTo(1.3, 6);
    expect(m.windowDeviationPct).toBeCloseTo(30.0, 6);
    expect(m.slope).toBeCloseTo(7.0, 6);
  });

  it('eliminates false opening dip from heavy auction surge and avoids afternoon large-base damping', () => {
    // 1. 开盘竞价+首分钟大幅放量 +40%，随后连续竞价稳定放量 +15%
    //    旧累计斜率公式会算出约 -2.3%/分 的假急缩深坑；方案 A 边际量比应稳定 +15%、斜率为 0%/分
    const prevSeries: MinuteTurnoverPoint[] = [];
    const todaySeries: MinuteTurnoverPoint[] = [];
    let pCum = 300; // 含竞价与 09:30 首分钟
    let tCum = 420; // 首分钟同比 +40%
    prevSeries.push({ minuteIndex: 0, cumTurnover: pCum });
    todaySeries.push({ minuteIndex: 0, cumTurnover: tCum });

    for (let k = 1; k <= 220; k++) {
      pCum += 100;
      tCum += 115; // 连续竞价每分钟稳定放量 +15%
      prevSeries.push({ minuteIndex: k, cumTurnover: pCum });
      todaySeries.push({ minuteIndex: k, cumTurnover: tCum });
    }

    const at0935 = evaluateEnergy({ todaySeries, prevSeries, minuteIndex: 5, elapsedSeconds: 60 });
    expect(at0935.windowMultiple).toBeCloseTo(1.15, 6);
    expect(at0935.windowDeviationPct).toBeCloseTo(15.0, 6);
    expect(at0935.slope).toBeCloseTo(0.0, 6);

    // 2. 早盘 t=15 与尾盘 t=215 注入完全同等强度的 5 分钟放量脉冲：
    //    早盘与尾盘的 M_5、D_5 与斜率 S_5 必须完全一致（零大基数钝化）
    const makePulseSeries = (pulseStart: number) => {
      const pArr: MinuteTurnoverPoint[] = [];
      const tArr: MinuteTurnoverPoint[] = [];
      let p = 300;
      let t = 300;
      pArr.push({ minuteIndex: 0, cumTurnover: p });
      tArr.push({ minuteIndex: 0, cumTurnover: t });
      for (let k = 1; k <= 230; k++) {
        p += 100;
        const offset = k - pulseStart;
        const factor = offset >= 0 && offset < 5 ? 1 + (offset + 1) * 0.15 : 1.0;
        t += 100 * factor;
        pArr.push({ minuteIndex: k, cumTurnover: p });
        tArr.push({ minuteIndex: k, cumTurnover: t });
      }
      return { pArr, tArr };
    };

    const morning = makePulseSeries(11);
    const afternoon = makePulseSeries(211);
    const mMorning = evaluateEnergy({
      todaySeries: morning.tArr,
      prevSeries: morning.pArr,
      minuteIndex: 15,
      elapsedSeconds: 60,
    });
    const mAfternoon = evaluateEnergy({
      todaySeries: afternoon.tArr,
      prevSeries: afternoon.pArr,
      minuteIndex: 215,
      elapsedSeconds: 60,
    });

    expect(mAfternoon.windowMultiple).toBeCloseTo(mMorning.windowMultiple!, 6);
    expect(mAfternoon.windowDeviationPct).toBeCloseTo(mMorning.windowDeviationPct!, 6);
    expect(mAfternoon.slope).toBeCloseTo(mMorning.slope!, 6);
    expect(mAfternoon.slope!).toBeGreaterThan(5);
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

  it('keeps rolling marginal slope continuous across lunch break (11:28 -> 13:02)', () => {
    // minuteIndex 113(11:23) .. 122(13:02)，午休 11:30-13:00 完全折叠
    // 窗口 W=5 在 t=122(13:02) 上取 k ∈ [118, 119, 120, 121, 122]，对应锚点 [113..117]
    const prevSeries: MinuteTurnoverPoint[] = [];
    const todaySeries: MinuteTurnoverPoint[] = [];
    let prevCum = 10_000;
    let todayCum = 10_000;

    for (let k = 113; k <= 122; k++) {
      prevCum += 500;
      // k=118..122 每分钟同比递增 +10%, +20%, +30%, +40%, +50%
      const extra = k >= 118 ? (k - 117) * 50 : 0;
      todayCum += 500 + extra;
      prevSeries.push({ minuteIndex: k, cumTurnover: prevCum });
      todaySeries.push({ minuteIndex: k, cumTurnover: todayCum });
    }

    const metrics = evaluateEnergy({
      todaySeries,
      prevSeries,
      minuteIndex: 122,
      elapsedSeconds: 60,
    });

    // D_5(118..122) = [+2%, +6%, +12%, +20%, +30%] → OLS 斜率精确 +7.0%/min
    expect(metrics.windowMultiple).toBeCloseTo(1.3, 6);
    expect(metrics.windowDeviationPct).toBeCloseTo(30.0, 6);
    expect(metrics.slope).toBeCloseTo(7.0, 6);
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
    expect(missingPrev.windowDeviationPct).toBeNull();

    // 2. 昨日同期为 0
    const zeroPrev = evaluateEnergy({
      todaySeries: [{ minuteIndex: 10, cumTurnover: 500 }],
      prevSeries: [{ minuteIndex: 10, cumTurnover: 0 }],
      minuteIndex: 10,
    });
    expect(zeroPrev.cumRatio).toBeNull();
    expect(zeroPrev.volumeState).toBe('UNAVAILABLE');

    // 3. 昨日区间增量为 0（停牌/无成交），分母 <= 0 → windowMultiple 与边际 slope 均不可用
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
    expect(flatPrev.windowDeviationPct).toBeNull();
    expect(flatPrev.slope).toBeNull();

    // 4. OLS 少于 2 点返回 null
    expect(computeOlsSlope([[0, 1]])).toBeNull();
  });

  it('handles minuteIndex=0 unclosed interpolation accurately and avoids silent zero-fill when prevAuctionTurnover is missing', () => {
    const prevAuction = 127.29e8;
    const prevM0 = 513.45e8;
    const todayAt10s = prevAuction + (10 / 60) * (prevM0 - prevAuction);

    const withAuction = evaluateEnergy({
      todaySeries: [],
      prevSeries: [{ minuteIndex: 0, cumTurnover: prevM0 }],
      minuteIndex: 0,
      currentTodayCumTurnover: todayAt10s,
      elapsedSeconds: 10,
      prevAuctionTurnover: prevAuction,
    });
    expect(withAuction.prevAlignedCumTurnover).toBeCloseTo(todayAt10s, 2);
    expect(withAuction.cumRatioPct).toBeCloseTo(0, 6);
    expect(withAuction.volumeState).toBe('FLAT');

    const missingAuction = evaluateEnergy({
      todaySeries: [],
      prevSeries: [{ minuteIndex: 0, cumTurnover: prevM0 }],
      minuteIndex: 0,
      currentTodayCumTurnover: todayAt10s,
      elapsedSeconds: 10,
    });
    expect(missingAuction.prevAlignedCumTurnover).toBeNull();
    expect(missingAuction.cumRatio).toBeNull();
    expect(missingAuction.volumeState).toBe('UNAVAILABLE');

    const explicitZeroAuction = evaluateEnergy({
      todaySeries: [],
      prevSeries: [{ minuteIndex: 0, cumTurnover: 600 }],
      minuteIndex: 0,
      currentTodayCumTurnover: 100,
      elapsedSeconds: 10,
      prevAuctionTurnover: 0,
    });
    expect(explicitZeroAuction.prevAlignedCumTurnover).toBeCloseTo(100, 6);
    expect(explicitZeroAuction.volumeState).toBe('FLAT');

    const closedM0 = evaluateEnergy({
      todaySeries: [{ minuteIndex: 0, cumTurnover: prevM0 }],
      prevSeries: [{ minuteIndex: 0, cumTurnover: prevM0 }],
      minuteIndex: 0,
      elapsedSeconds: 60,
    });
    expect(closedM0.volumeState).toBe('FLAT');
    expect(closedM0.cumRatioPct).toBeCloseTo(0, 6);
  });

  it('guards against NaN elapsedSeconds and matches analytical marginal OLS across W=3, 5, 10', () => {
    const nanElapsed = evaluateEnergy({
      todaySeries: [{ minuteIndex: 10, cumTurnover: 1000 }],
      prevSeries: [
        { minuteIndex: 9, cumTurnover: 900 },
        { minuteIndex: 10, cumTurnover: 1000 },
      ],
      minuteIndex: 10,
      elapsedSeconds: Number.NaN,
    });
    expect(Number.isNaN(nanElapsed.elapsedSeconds)).toBe(false);
    expect(nanElapsed.prevAlignedCumTurnover).toBeNull();
    expect(nanElapsed.volumeState).toBe('UNAVAILABLE');

    // 昨日每分钟匀速 1000，今日第 k 分钟单分钟成交 = 1000 * (1 + 0.02 * k)
    // 对任意满窗口 W，D_W(k) = 2 * k - (W - 1)（严格线性递增 +2%/min！）
    const prevSeries: MinuteTurnoverPoint[] = [];
    const todaySeries: MinuteTurnoverPoint[] = [];
    let pCum = 0;
    let tCum = 0;
    for (let k = 0; k < 25; k++) {
      pCum += 1000;
      tCum += 1000 * (1 + 0.02 * k);
      prevSeries.push({ minuteIndex: k, cumTurnover: pCum });
      todaySeries.push({ minuteIndex: k, cumTurnover: tCum });
    }

    for (const W of [3, 5, 10]) {
      const m = evaluateEnergy({
        todaySeries,
        prevSeries,
        minuteIndex: 20,
        elapsedSeconds: 60,
        config: { slopeWindow: W },
      });
      const expectedMult =
        (todaySeries[20].cumTurnover - todaySeries[20 - W].cumTurnover) /
        (prevSeries[20].cumTurnover - prevSeries[20 - W].cumTurnover);
      expect(m.windowMultiple).toBeCloseTo(expectedMult, 6);
      expect(m.windowDeviationPct).toBeCloseTo((expectedMult - 1) * 100, 6);
      expect(m.slope).toBeCloseTo(2.0, 6);
    }
  });
});
