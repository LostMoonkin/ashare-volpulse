/**
 * 统一能量计算引擎（纯 TypeScript，零 IO）
 *
 * 适用于沪深两市聚合（MARKET_TOTAL）、四大核心指数及任意自选个股。
 * 所有数学公式严格对齐 docs/PLAN.md §2.3：
 * - 未闭合分钟线性插值对齐昨日同期：A_prev_aligned(t) = A_prev(t-1) + (s / 60) * Δa_prev(t)
 * - 同比差额 ΔA(t) = A_today(t) - A_prev_aligned(t)
 * - 同比变化率 R(t) = ΔA(t) / A_prev_aligned(t)（仅当分母 > 0）
 * - 全天预测成交额 Â_full(t) = A_prev_full * (A_today(t) / A_prev_aligned(t))
 * - 放/平/缩量状态：R(t)*100 >= +5% 放量，<= -5% 缩量，其余平量，不可计算为 UNAVAILABLE
 * - OLS 滚动斜率 S_W(t)：对窗口 [t-W+1, t] 的 {(k, R(k)*100)} 做普通最小二乘回归（百分点/分钟）
 * - 滚动区间增量倍数 M_W(t) = (A_today(t) - A_today(t-W)) / (A_prev_aligned(t) - A_prev(t-W))
 */

export type VolumeState = 'EXPANDING' | 'FLAT' | 'SHRINKING' | 'UNAVAILABLE';

export interface MinuteTurnoverPoint {
  readonly minuteIndex: number;
  /** 截至该分钟的累计成交额（人民币元） */
  readonly cumTurnover: number;
}

export interface EnergyEngineConfig {
  /** 放量阈值（百分比数值，默认 5 即 +5%） */
  readonly expandThresholdPct: number;
  /** 缩量阈值（百分比数值，默认 -5 即 -5%） */
  readonly shrinkThresholdPct: number;
  /** 滚动斜率与区间增量倍数窗口长度 W（分钟，默认 5，可选 3/5/10） */
  readonly slopeWindow: number;
}

export const DEFAULT_ENERGY_CONFIG: EnergyEngineConfig = {
  expandThresholdPct: 5,
  shrinkThresholdPct: -5,
  slopeWindow: 5,
};

export interface EnergyEvaluationInput {
  /** 今日连续交易分钟序列（仅含 minuteIndex 0..239，不含 09:25 竞价锚点） */
  readonly todaySeries: readonly MinuteTurnoverPoint[];
  /** 上一交易日连续交易分钟序列（0..239） */
  readonly prevSeries: readonly MinuteTurnoverPoint[];
  /** 当前评估的连续交易分钟索引 t ∈ [0, 239] */
  readonly minuteIndex: number;
  /** 盘中未闭合分钟的实时累计成交额（元）；省略时从 todaySeries[minuteIndex] 读取 */
  readonly currentTodayCumTurnover?: number | null;
  /** 当前分钟已过秒数 s ∈ [0, 60]；默认 60 表示该分钟已闭合 */
  readonly elapsedSeconds?: number;
  /** 上一交易日全天总成交额（元）；缺失或 <= 0 时不输出全天预测 */
  readonly prevFullDayTurnover?: number | null;
  /** 昨日 09:25 开盘集合竞价成交额（元），仅用于 t=0 未闭合分钟插值基准（不进入斜率窗口） */
  readonly prevAuctionTurnover?: number | null;
  /** 阈值与窗口配置（可选，缺省使用默认参数） */
  readonly config?: Partial<EnergyEngineConfig>;
}

export interface EnergyMetrics {
  readonly minuteIndex: number;
  readonly elapsedSeconds: number;
  readonly todayCumTurnover: number | null;
  readonly prevAlignedCumTurnover: number | null;
  /** 同比差额 ΔA(t)（元），无法计算时为 null */
  readonly cumDiff: number | null;
  /** 同比变化率 R(t)（小数形式，如 +0.12 表示 +12%），无法计算时为 null */
  readonly cumRatio: number | null;
  /** 同比变化率百分比 R(t) * 100（如 +12），无法计算时为 null */
  readonly cumRatioPct: number | null;
  /** 全天预测成交额 Â_full(t)（元），无法计算或无昨日全天额时为 null */
  readonly predictedFullDayTurnover: number | null;
  readonly volumeState: VolumeState;
  /** OLS 滚动斜率 S_W(t)（百分点/分钟），窗口不足或任一点不可用时为 null */
  readonly slope: number | null;
  /** 滚动区间增量倍数 M_W(t)（倍），分母 <= 0 或窗口点缺失时为 null */
  readonly windowMultiple: number | null;
  readonly slopeWindow: number;
}

function isValidNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function toTurnoverMap(series: readonly MinuteTurnoverPoint[]): Map<number, number> {
  const map = new Map<number, number>();
  for (const p of series) {
    if (
      Number.isInteger(p.minuteIndex) &&
      p.minuteIndex >= 0 &&
      p.minuteIndex <= 239 &&
      isValidNumber(p.cumTurnover) &&
      p.cumTurnover >= 0
    ) {
      map.set(p.minuteIndex, p.cumTurnover);
    }
  }
  return map;
}

/**
 * 普通最小二乘（OLS）线性回归斜率。
 * 点集不足 2 个或 x 方差为 0 时返回 null。
 */
export function computeOlsSlope(points: ReadonlyArray<readonly [number, number]>): number | null {
  const n = points.length;
  if (n < 2) return null;

  let sumX = 0;
  let sumY = 0;
  for (const [x, y] of points) {
    sumX += x;
    sumY += y;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;

  let numerator = 0;
  let denominator = 0;
  for (const [x, y] of points) {
    const dx = x - meanX;
    numerator += dx * (y - meanY);
    denominator += dx * dx;
  }

  if (denominator <= 0) return null;
  return numerator / denominator;
}

/**
 * 对齐昨日同期累计成交额：
 * - elapsedSeconds >= 60：直接返回 A_prev(t)
 * - elapsedSeconds ∈ [0, 60)：采用 A_prev(t-1) + (s / 60) * Δa_prev(t) 线性插值
 * - 任一所需基线缺失时返回 null（绝不补零）
 */
export function alignPrevCumTurnover(
  prevMap: ReadonlyMap<number, number>,
  minuteIndex: number,
  elapsedSeconds: number,
  prevAuctionTurnover?: number | null
): number | null {
  const prevAtT = prevMap.get(minuteIndex);
  if (prevAtT === undefined) return null;

  const clampedSeconds = Math.max(0, Math.min(60, elapsedSeconds));
  if (clampedSeconds >= 60) {
    return prevAtT;
  }

  let prevBase: number;
  if (minuteIndex === 0) {
    prevBase =
      isValidNumber(prevAuctionTurnover) && prevAuctionTurnover >= 0 ? prevAuctionTurnover : 0;
  } else {
    const prevAtPrevMinute = prevMap.get(minuteIndex - 1);
    if (prevAtPrevMinute === undefined) {
      return null;
    }
    prevBase = prevAtPrevMinute;
  }

  const delta = Math.max(0, prevAtT - prevBase);
  return prevBase + (clampedSeconds / 60) * delta;
}

/**
 * 计算单个标的（大盘聚合、四大指数或任意个股）在指定时刻的能量指标。
 */
export function evaluateEnergy(input: EnergyEvaluationInput): EnergyMetrics {
  const cfg: EnergyEngineConfig = {
    expandThresholdPct: input.config?.expandThresholdPct ?? DEFAULT_ENERGY_CONFIG.expandThresholdPct,
    shrinkThresholdPct: input.config?.shrinkThresholdPct ?? DEFAULT_ENERGY_CONFIG.shrinkThresholdPct,
    slopeWindow: input.config?.slopeWindow ?? DEFAULT_ENERGY_CONFIG.slopeWindow,
  };

  const t = input.minuteIndex;
  const elapsedSeconds = Math.max(0, Math.min(60, input.elapsedSeconds ?? 60));
  const todayMap = toTurnoverMap(input.todaySeries);
  const prevMap = toTurnoverMap(input.prevSeries);

  const todayAtT =
    input.currentTodayCumTurnover !== undefined
      ? isValidNumber(input.currentTodayCumTurnover) && input.currentTodayCumTurnover >= 0
        ? input.currentTodayCumTurnover
        : null
      : todayMap.get(t) ?? null;

  const prevAlignedAtT = alignPrevCumTurnover(
    prevMap,
    t,
    elapsedSeconds,
    input.prevAuctionTurnover
  );

  let cumDiff: number | null = null;
  let cumRatio: number | null = null;
  let cumRatioPct: number | null = null;
  let predictedFullDayTurnover: number | null = null;
  let volumeState: VolumeState = 'UNAVAILABLE';

  if (todayAtT !== null && prevAlignedAtT !== null && prevAlignedAtT > 0) {
    cumDiff = todayAtT - prevAlignedAtT;
    cumRatio = cumDiff / prevAlignedAtT;
    cumRatioPct = cumRatio * 100;

    if (cumRatioPct >= cfg.expandThresholdPct) {
      volumeState = 'EXPANDING';
    } else if (cumRatioPct <= cfg.shrinkThresholdPct) {
      volumeState = 'SHRINKING';
    } else {
      volumeState = 'FLAT';
    }

    if (isValidNumber(input.prevFullDayTurnover) && input.prevFullDayTurnover > 0) {
      predictedFullDayTurnover = input.prevFullDayTurnover * (todayAtT / prevAlignedAtT);
    }
  }

  // 指标 A：OLS 滚动斜率 S_W(t)（仅在折叠后的连续 minuteIndex 窗口 [t - W + 1, t] 上计算）
  const W = cfg.slopeWindow;
  let slope: number | null = null;
  if (Number.isInteger(W) && W >= 2 && t - W + 1 >= 0) {
    const windowPoints: Array<[number, number]> = [];
    let allValid = true;
    for (let k = t - W + 1; k <= t; k++) {
      if (k === t) {
        if (cumRatioPct === null) {
          allValid = false;
          break;
        }
        windowPoints.push([k, cumRatioPct]);
      } else {
        const tk = todayMap.get(k);
        const pk = prevMap.get(k);
        if (tk === undefined || pk === undefined || pk <= 0) {
          allValid = false;
          break;
        }
        windowPoints.push([k, ((tk - pk) / pk) * 100]);
      }
    }
    if (allValid && windowPoints.length === W) {
      slope = computeOlsSlope(windowPoints);
    }
  }

  // 指标 B：滚动区间增量倍数 M_W(t) = (A_today(t) - A_today(t-W)) / (A_prev_aligned(t) - A_prev(t-W))
  let windowMultiple: number | null = null;
  if (
    Number.isInteger(W) &&
    W >= 1 &&
    t - W >= 0 &&
    todayAtT !== null &&
    prevAlignedAtT !== null
  ) {
    const todayAnchor = todayMap.get(t - W);
    const prevAnchor = prevMap.get(t - W);
    if (todayAnchor !== undefined && prevAnchor !== undefined) {
      const todayDelta = todayAtT - todayAnchor;
      const prevDelta = prevAlignedAtT - prevAnchor;
      if (prevDelta > 0 && todayDelta >= 0) {
        windowMultiple = todayDelta / prevDelta;
      }
    }
  }

  return {
    minuteIndex: t,
    elapsedSeconds,
    todayCumTurnover: todayAtT,
    prevAlignedCumTurnover: prevAlignedAtT,
    cumDiff,
    cumRatio,
    cumRatioPct,
    predictedFullDayTurnover,
    volumeState,
    slope,
    windowMultiple,
    slopeWindow: W,
  };
}

/**
 * 批量计算今日已闭合分钟序列（0..lastMinuteIndex）的完整能量指标曲线，供图表渲染与复盘使用。
 */
export function evaluateEnergySeries(params: {
  readonly todaySeries: readonly MinuteTurnoverPoint[];
  readonly prevSeries: readonly MinuteTurnoverPoint[];
  readonly prevFullDayTurnover?: number | null;
  readonly prevAuctionTurnover?: number | null;
  readonly config?: Partial<EnergyEngineConfig>;
}): EnergyMetrics[] {
  const sortedIndices = [...new Set(params.todaySeries.map((p) => p.minuteIndex))]
    .filter((idx) => Number.isInteger(idx) && idx >= 0 && idx <= 239)
    .sort((a, b) => a - b);

  return sortedIndices.map((minuteIndex) =>
    evaluateEnergy({
      todaySeries: params.todaySeries,
      prevSeries: params.prevSeries,
      minuteIndex,
      elapsedSeconds: 60,
      prevFullDayTurnover: params.prevFullDayTurnover,
      prevAuctionTurnover: params.prevAuctionTurnover,
      config: params.config,
    })
  );
}
