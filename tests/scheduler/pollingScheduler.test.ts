import { describe, expect, it, vi } from 'vitest';
import { minuteIndexToLabel, shanghaiToTimestampMs } from '../../src/core/tradingClock';
import {
  HithinkProvider,
  ProviderRequestError,
  type MarketDataProvider,
} from '../../src/main/providers';
import { PollingScheduler } from '../../src/main/scheduler';
import { AppDatabase } from '../../src/main/storage/database';
import type {
  AlertEventInput,
  IntradayBarRow,
  IntradayDayData,
  MarketDashboardState,
  ProviderId,
  QuoteSnapshot,
} from '../../src/shared/types';

function makeIntradayDay(params: {
  symbol: string;
  tradeDate: string;
  barCount: number;
  baseTurnoverPerMin: number;
  auctionTurnover?: number;
  skipMinutes?: ReadonlySet<number>;
  source?: ProviderId;
}): IntradayDayData {
  const auctionTurnover = params.auctionTurnover ?? params.baseTurnoverPerMin;
  const bars: IntradayBarRow[] = [];
  let cumTurnover = auctionTurnover;
  let cumVolume = 100_000;

  for (let idx = 0; idx < params.barCount; idx++) {
    cumTurnover += params.baseTurnoverPerMin;
    cumVolume += 50_000;
    if (params.skipMinutes?.has(idx)) {
      continue;
    }
    bars.push({
      symbol: params.symbol,
      tradeDate: params.tradeDate,
      minuteIndex: idx,
      minuteStr: minuteIndexToLabel(idx),
      price: 3500 + idx * 0.1,
      cumVolume,
      cumTurnover,
      barTurnover: params.baseTurnoverPerMin,
      source: params.source ?? 'tencent',
    });
  }

  return {
    symbol: params.symbol,
    tradeDate: params.tradeDate,
    prevClose: 3500,
    auction: { openPrice: 3500, auctionTurnover },
    bars,
    source: params.source ?? 'tencent',
  };
}

function makeSnapshot(params: {
  symbol: string;
  name?: string;
  tradeDate: string;
  timestampMs: number;
  turnover: number;
  price?: number;
  source?: ProviderId;
}): QuoteSnapshot {
  return {
    symbol: params.symbol,
    name: params.name ?? params.symbol,
    price: params.price ?? 3550,
    prevClose: 3500,
    open: 3510,
    high: 3560,
    low: 3505,
    changeAmt: 50,
    changePct: 1.43,
    volumeShares: 10_000_000,
    turnover: params.turnover,
    tradeDate: params.tradeDate,
    timestampMs: params.timestampMs,
    source: params.source ?? 'tencent',
  };
}

function createFakeProvider(
  id: ProviderId,
  overrides: Partial<MarketDataProvider> = {}
): MarketDataProvider {
  return {
    id,
    fetchBatchSnapshots: vi.fn(async () => new Map<string, QuoteSnapshot>()),
    fetchIntradayMinutes: vi.fn(async () => []),
    searchTickers: vi.fn(async () => []),
    healthCheck: vi.fn(async () => ({ provider: id, ok: true, latencyMs: 12, error: null })),
    ...overrides,
  };
}

function createFakeHithink(params: {
  configured: boolean;
  tradingDays?: string[];
  snapshots?: (symbols: readonly string[]) => Promise<Map<string, QuoteSnapshot>>;
}): HithinkProvider {
  const secretStore = {
    getApiKey: () => (params.configured ? 'fake-key' : null),
  };
  const provider = new HithinkProvider({
    secretStore,
    sleepImpl: async () => {},
  });

  vi.spyOn(provider, 'fetchTradingDays').mockImplementation(async () => {
    if (!params.configured) {
      throw new ProviderRequestError({ provider: 'hithink', message: 'not configured' });
    }
    return (params.tradingDays ?? ['2026-11-20', '2026-11-23', '2026-11-24']).map((date) => ({
      date,
      isOpen: true,
    }));
  });

  if (params.snapshots) {
    vi.spyOn(provider, 'fetchBatchSnapshots').mockImplementation(async (syms) =>
      params.snapshots!(syms)
    );
  }

  return provider;
}

describe('PollingScheduler', () => {
  it('backfills 09:30-10:34 today and full 240 prev-day minutes on 10:35 startup and runs LIVE poll', async () => {
    const db = new AppDatabase(':memory:');
    const nowMs = shanghaiToTimestampMs('2026-11-24', 10, 35, 15); // minuteIndex = 65

    const primary = createFakeProvider('tencent', {
      fetchIntradayMinutes: vi.fn(async (symbol) => [
        makeIntradayDay({
          symbol,
          tradeDate: '2026-11-24',
          barCount: 65, // 0..64 (09:30..10:34)
          baseTurnoverPerMin: 2e9,
        }),
        makeIntradayDay({
          symbol,
          tradeDate: '2026-11-23',
          barCount: 240,
          baseTurnoverPerMin: 1.5e9,
        }),
      ]),
      fetchBatchSnapshots: vi.fn(async (symbols) => {
        const map = new Map<string, QuoteSnapshot>();
        for (const sym of symbols) {
          map.set(
            sym,
            makeSnapshot({
              symbol: sym,
              tradeDate: '2026-11-24',
              timestampMs: nowMs,
              turnover: 133e9,
              source: 'tencent',
            })
          );
        }
        return map;
      }),
    });

    const secondary = createFakeProvider('sina');
    const eastmoney = createFakeProvider('eastmoney');
    const hithink = createFakeHithink({ configured: true });

    const pushedStates: MarketDashboardState[] = [];
    const scheduler = new PollingScheduler({
      database: db,
      secretStore: {
        getApiKey: () => 'fake-key',
        getStatus: () => ({ configured: true, source: 'env', encryptionAvailable: true }),
      },
      primarySnapshotProvider: primary,
      secondarySnapshotProvider: secondary,
      hithinkProvider: hithink,
      primaryIntradayProvider: primary,
      secondaryIntradayProvider: eastmoney,
      nowFn: () => nowMs,
      sleepFn: async () => {},
      backfillDelayMs: 0,
      onStateUpdate: (s) => pushedStates.push(s),
    });

    const state = await scheduler.tickOnce();

    expect(state.status.mode).toBe('LIVE');
    expect(state.status.phase).toBe('MORNING_SESSION');
    expect(state.status.calendarSource).toBe('hithink');
    expect(state.status.calendarDegraded).toBe(false);
    expect(state.status.activeSnapshotProvider).toBe('tencent');
    expect(state.status.degraded).toBe(false);
    expect(pushedStates).toHaveLength(1);

    // 验证 SQLite 已落盘昨日完整 240 分钟 + 今日已过 65 分钟（09:30..10:34）
    expect(db.getIntradayBars('000001.SH', '2026-11-23')).toHaveLength(240);
    expect(db.getIntradayBars('000001.SH', '2026-11-24')).toHaveLength(65);
    expect(db.getIntradayBars('399106.SZ', '2026-11-23')).toHaveLength(240);

    // 两市总成交额 = 000001.SH + 399106.SZ = 266e9，绝不叠加其他 3 只指数
    expect(state.marketTotal.cumTurnover).toBe(266e9);
    expect(state.marketTotal.degraded).toBe(false);
    expect(state.marketTotal.metrics?.volumeState).toBe('EXPANDING');
    expect(state.indices).toHaveLength(4);

    // 二次 tick 不应重复回补已有分时，只执行一次批量快照请求
    await scheduler.tickOnce();
    expect(primary.fetchIntradayMinutes).toHaveBeenCalledTimes(5); // 仅首次 5 指数各 1 次
    expect(primary.fetchBatchSnapshots).toHaveBeenCalledTimes(2);

    db.close();
  });

  it('serves REPLAY mode after close and on closed days with zero high-frequency snapshot requests', async () => {
    const db = new AppDatabase(':memory:');
    // 预置 35 个交易日以验证盘后触发 30 日滚动清理
    const openDays: string[] = [];
    for (let i = 0; i < 35; i++) {
      const dt = new Date(Date.UTC(2026, 9, 1 + i));
      openDays.push(dt.toISOString().slice(0, 10));
    }
    const lastDay = openDays[34]; // 2026-11-04
    const prevDay = openDays[33]; // 2026-11-03

    // 写入一条最旧交易日的历史数据，期望盘后被清理
    db.upsertIntradayBars([
      {
        symbol: '000001.SH',
        tradeDate: openDays[0],
        minuteIndex: 0,
        minuteStr: '09:30',
        price: 3000,
        cumVolume: 1000,
        cumTurnover: 1e8,
        barTurnover: 1e8,
        source: 'tencent',
      },
    ]);

    const primary = createFakeProvider('tencent', {
      fetchIntradayMinutes: vi.fn(async (symbol) => [
        makeIntradayDay({ symbol, tradeDate: lastDay, barCount: 240, baseTurnoverPerMin: 2e9 }),
        makeIntradayDay({ symbol, tradeDate: prevDay, barCount: 240, baseTurnoverPerMin: 1.8e9 }),
      ]),
    });
    const secondary = createFakeProvider('sina');
    const eastmoney = createFakeProvider('eastmoney');
    const hithink = createFakeHithink({ configured: true, tradingDays: openDays });

    // 1. 盘后 15:30 启动
    let currentNow = shanghaiToTimestampMs(lastDay, 15, 30, 0);
    const scheduler = new PollingScheduler({
      database: db,
      secretStore: {
        getApiKey: () => 'fake-key',
        getStatus: () => ({ configured: true, source: 'env', encryptionAvailable: true }),
      },
      primarySnapshotProvider: primary,
      secondarySnapshotProvider: secondary,
      hithinkProvider: hithink,
      primaryIntradayProvider: primary,
      secondaryIntradayProvider: eastmoney,
      nowFn: () => currentNow,
      sleepFn: async () => {},
      backfillDelayMs: 0,
    });

    const postMarketState = await scheduler.tickOnce();
    expect(postMarketState.status.mode).toBe('REPLAY');
    expect(postMarketState.status.phase).toBe('POST_MARKET');
    expect(postMarketState.status.tradeDate).toBe(lastDay);
    expect(postMarketState.status.prevTradeDate).toBe(prevDay);
    expect(postMarketState.marketTotal.todaySeries).toHaveLength(240);
    expect(postMarketState.marketTotal.metrics?.volumeState).toBe('EXPANDING');
    // 盘后零高频快照请求
    expect(primary.fetchBatchSnapshots).not.toHaveBeenCalled();
    expect(secondary.fetchBatchSnapshots).not.toHaveBeenCalled();
    // 盘后自动触发一次 30 交易日清理
    expect(db.getIntradayBars('000001.SH', openDays[0])).toHaveLength(0);

    // 2. 休市日（非交易日 2026-11-07 周六）启动
    currentNow = shanghaiToTimestampMs('2026-11-07', 10, 30, 0);
    const closedDayState = await scheduler.tickOnce();
    expect(closedDayState.status.mode).toBe('REPLAY');
    expect(closedDayState.status.phase).toBe('CLOSED_DAY');
    expect(closedDayState.status.tradeDate).toBe(lastDay);
    expect(primary.fetchBatchSnapshots).not.toHaveBeenCalled();

    db.close();
  });

  it('fails over from primary to secondary on errors with exponential backoff and recovers when primary heals', async () => {
    const db = new AppDatabase(':memory:');
    let nowMs = shanghaiToTimestampMs('2026-11-24', 10, 0, 0);
    let primaryShouldFail = true;
    let primaryHealthy = false;

    const makeAllSnaps = (symbols: readonly string[], source: ProviderId) => {
      const m = new Map<string, QuoteSnapshot>();
      for (const s of symbols) {
        m.set(s, makeSnapshot({ symbol: s, tradeDate: '2026-11-24', timestampMs: nowMs, turnover: 60e9, source }));
      }
      return m;
    };

    const primary = createFakeProvider('tencent', {
      fetchIntradayMinutes: vi.fn(async (symbol) => [
        makeIntradayDay({ symbol, tradeDate: '2026-11-24', barCount: 30, baseTurnoverPerMin: 2e9 }),
        makeIntradayDay({ symbol, tradeDate: '2026-11-23', barCount: 240, baseTurnoverPerMin: 2e9 }),
      ]),
      fetchBatchSnapshots: vi.fn(async (symbols) => {
        if (primaryShouldFail) {
          throw new ProviderRequestError({
            provider: 'tencent',
            message: 'timeout',
            retryable: true,
          });
        }
        return makeAllSnaps(symbols, 'tencent');
      }),
      healthCheck: vi.fn(async () => ({
        provider: 'tencent' as const,
        ok: primaryHealthy,
        latencyMs: 18,
        error: primaryHealthy ? null : 'down',
      })),
    });

    const secondary = createFakeProvider('sina', {
      fetchBatchSnapshots: vi.fn(async (symbols) => makeAllSnaps(symbols, 'sina')),
    });

    const eastmoney = createFakeProvider('eastmoney');
    const hithink = createFakeHithink({ configured: true });

    const scheduler = new PollingScheduler({
      database: db,
      secretStore: {
        getApiKey: () => 'fake-key',
        getStatus: () => ({ configured: true, source: 'env', encryptionAvailable: true }),
      },
      primarySnapshotProvider: primary,
      secondarySnapshotProvider: secondary,
      hithinkProvider: hithink,
      primaryIntradayProvider: primary,
      secondaryIntradayProvider: eastmoney,
      configuredIntervalSec: 3,
      nowFn: () => nowMs,
      sleepFn: async () => {},
      backfillDelayMs: 0,
    });

    // 第 1 次失败：退避 3 -> 6s，未切源
    const s1 = await scheduler.tickOnce();
    expect(s1.status.activeSnapshotProvider).toBe('tencent');
    expect(s1.status.pollingIntervalSec).toBe(6);
    expect(s1.status.consecutiveFailures).toBe(1);

    // 第 2 次失败：退避 6 -> 12s，未切源
    nowMs += 6_000;
    const s2 = await scheduler.tickOnce();
    expect(s2.status.activeSnapshotProvider).toBe('tencent');
    expect(s2.status.pollingIntervalSec).toBe(12);

    // 第 3 次失败：触发故障转移至新浪并当次补拉成功，间隔从 24 回落到 12
    nowMs += 12_000;
    const s3 = await scheduler.tickOnce();
    expect(s3.status.activeSnapshotProvider).toBe('sina');
    expect(s3.status.lastLatencyMs).not.toBeNull();
    expect(s3.status.consecutiveFailures).toBe(0);
    expect(s3.status.pollingIntervalSec).toBe(12);

    // 连续成功逐步回落至配置间隔 3s
    nowMs += 12_000;
    const s4 = await scheduler.tickOnce();
    expect(s4.status.pollingIntervalSec).toBe(6);
    nowMs += 6_000;
    const s5 = await scheduler.tickOnce();
    expect(s5.status.pollingIntervalSec).toBe(3);

    // 5 分钟后主源恢复健康 → 自动探测切回腾讯
    primaryShouldFail = false;
    primaryHealthy = true;
    nowMs += 5 * 60 * 1000 + 1000;
    const s6 = await scheduler.tickOnce();
    expect(primary.healthCheck).toHaveBeenCalledTimes(1);
    expect(s6.status.activeSnapshotProvider).toBe('tencent');
    expect(s6.status.pollingIntervalSec).toBe(3);

    db.close();
  });

  it('never zero-fills missing upstream minutes and runs cleanly without Hithink API key (degraded calendar)', async () => {
    const db = new AppDatabase(':memory:');
    const nowMs = shanghaiToTimestampMs('2026-11-24', 10, 10, 0); // minuteIndex = 40

    const primary = createFakeProvider('tencent', {
      fetchIntradayMinutes: vi.fn(async (symbol) => [
        makeIntradayDay({
          symbol,
          tradeDate: '2026-11-24',
          barCount: 40,
          baseTurnoverPerMin: 2e9,
          // 模拟上游缺失第 15 分钟
          skipMinutes: symbol === '000001.SH' ? new Set([15]) : undefined,
        }),
        makeIntradayDay({
          symbol,
          tradeDate: '2026-11-23',
          barCount: 240,
          baseTurnoverPerMin: 2e9,
        }),
      ]),
      fetchBatchSnapshots: vi.fn(async (symbols) => {
        const m = new Map<string, QuoteSnapshot>();
        for (const s of symbols) {
          m.set(s, makeSnapshot({ symbol: s, tradeDate: '2026-11-24', timestampMs: nowMs, turnover: 82e9, source: 'tencent' }));
        }
        return m;
      }),
    });

    const secondary = createFakeProvider('sina');
    const eastmoney = createFakeProvider('eastmoney');
    const hithink = createFakeHithink({ configured: false }); // 未配置 Key

    const scheduler = new PollingScheduler({
      database: db,
      secretStore: {
        getApiKey: () => null,
        getStatus: () => ({ configured: false, source: 'none', encryptionAvailable: true }),
      },
      primarySnapshotProvider: primary,
      secondarySnapshotProvider: secondary,
      hithinkProvider: hithink,
      primaryIntradayProvider: primary,
      secondaryIntradayProvider: eastmoney,
      nowFn: () => nowMs,
      sleepFn: async () => {},
      backfillDelayMs: 0,
    });

    const state = await scheduler.tickOnce();

    // 未配置同花顺 Key 时基于公开源推断交易日，且日历标记降级
    expect(state.status.calendarSource).toBe('inferred_degraded');
    expect(state.status.calendarDegraded).toBe(true);
    expect(state.status.tradeDate).toBe('2026-11-24');
    expect(state.status.prevTradeDate).toBe('2026-11-23');
    expect(state.status.degraded).toBe(true);

    // 上游缺失第 15 分钟：intraday_bars 中绝不出现补 0 的第 15 分钟，且状态带降级标记
    const shBars = db.getIntradayBars('000001.SH', '2026-11-24');
    expect(shBars).toHaveLength(39);
    expect(shBars.find((b) => b.minuteIndex === 15)).toBeUndefined();
    expect(state.marketTotal.degraded).toBe(true);

    db.close();
  });

  it('captures 09:25 auction, persists closed minute bars, picks up dynamic watchlist changes, and dispatches alerts', async () => {
    const db = new AppDatabase(':memory:');
    let nowMs = shanghaiToTimestampMs('2026-11-24', 9, 25, 10); // AUCTION_GAP
    const alerts: AlertEventInput[] = [];

    const primary = createFakeProvider('tencent', {
      fetchIntradayMinutes: vi.fn(async (symbol) => [
        makeIntradayDay({
          symbol,
          tradeDate: '2026-11-23',
          barCount: 240,
          baseTurnoverPerMin: 1e9,
          auctionTurnover: 1e9,
        }),
      ]),
      fetchBatchSnapshots: vi.fn(async (symbols) => {
        const m = new Map<string, QuoteSnapshot>();
        for (const s of symbols) {
          // 按当前时间决定成交额，构造清晰放量斜率
          const isGap = nowMs < shanghaiToTimestampMs('2026-11-24', 9, 30, 0);
          m.set(
            s,
            makeSnapshot({
              symbol: s,
              tradeDate: '2026-11-24',
              timestampMs: nowMs,
              turnover: isGap ? 1.2e9 : 25e9,
              source: 'tencent',
            })
          );
        }
        return m;
      }),
    });

    const secondary = createFakeProvider('sina');
    const eastmoney = createFakeProvider('eastmoney');
    const hithink = createFakeHithink({ configured: true });

    const scheduler = new PollingScheduler({
      database: db,
      secretStore: {
        getApiKey: () => 'fake-key',
        getStatus: () => ({ configured: true, source: 'env', encryptionAvailable: true }),
      },
      primarySnapshotProvider: primary,
      secondarySnapshotProvider: secondary,
      hithinkProvider: hithink,
      primaryIntradayProvider: primary,
      secondaryIntradayProvider: eastmoney,
      nowFn: () => nowMs,
      sleepFn: async () => {},
      backfillDelayMs: 0,
      onAlertTriggered: (ev) => alerts.push(ev),
    });

    // 1. 09:25 捕获开盘竞价并写入 auction_snapshots
    await scheduler.tickOnce();
    const shAuction = db.getAuctionSnapshot('000001.SH', '2026-11-24');
    expect(shAuction).not.toBeNull();
    expect(shAuction?.auctionTurnover).toBe(1.2e9);

    // 2. 动态添加自选股（不重启调度器），并按真实时间推进 09:30 -> 09:36 逐分钟闭合落盘并触发快速放量告警
    db.upsertWatchlistItem({
      symbol: '600519.SH',
      name: '贵州茅台',
      sortOrder: 0,
      alertEnabled: true,
      customThresholdsJson: null,
    });

    // 昨日 600519.SH 竞价 1e9、每分钟 +1e9 → prev(k) = (k + 2) * 1e9
    // 今日逐步加速放量：ratios = [0%, 0%, +2%, +5%, +9%, +14%, +25%]
    // 在 minuteIndex = 6（09:36:50，已过 50s）时斜率 >> +1.2%/分 且 区间倍数 >> 1.5x → 触发 SURGE 告警
    const targetCumByMinute = [2.0e9, 3.0e9, 4.08e9, 5.25e9, 6.54e9, 7.98e9, 10.5e9];
    for (let m = 0; m <= 6; m++) {
      nowMs = shanghaiToTimestampMs('2026-11-24', 9, 30 + m, 50);
      vi.mocked(primary.fetchBatchSnapshots).mockImplementationOnce(async (symbols) => {
        const snapMap = new Map<string, QuoteSnapshot>();
        for (const s of symbols) {
          snapMap.set(
            s,
            makeSnapshot({
              symbol: s,
              tradeDate: '2026-11-24',
              timestampMs: nowMs,
              turnover: targetCumByMinute[m],
              source: 'tencent',
            })
          );
        }
        return snapMap;
      });
      const st = await scheduler.tickOnce();
      if (m === 0) {
        expect(st.watchlist.map((w) => w.symbol)).toEqual(['600519.SH']);
      }
    }

    // 验证第 0..5 分钟已随分钟切换逐根闭合落盘到 SQLite
    const closedBars = db.getIntradayBars('600519.SH', '2026-11-24');
    expect(closedBars.map((b) => b.minuteIndex)).toEqual([0, 1, 2, 3, 4, 5]);
    // 验证冷启动保护后（minuteIndex >= 5）触发了快速放量告警派发回调
    expect(alerts.some((a) => a.symbol === '600519.SH' && a.direction === 'SURGE')).toBe(true);
    expect(alerts.every((a) => a.minuteIndex >= 5)).toBe(true);

    // 3. 删除自选股后下一轮立即移出监控
    db.removeWatchlistItem('600519.SH');
    const afterRemove = await scheduler.tickOnce();
    expect(afterRemove.watchlist).toHaveLength(0);

    db.close();
  });

  it('falls back to Eastmoney intraday and Hithink low-frequency snapshot (>=15s) when public sources fail', async () => {
    const db = new AppDatabase(':memory:');
    const nowMs = shanghaiToTimestampMs('2026-11-24', 10, 20, 30);

    const primary = createFakeProvider('tencent', {
      fetchIntradayMinutes: vi.fn(async () => {
        throw new ProviderRequestError({ provider: 'tencent', message: 'intraday down', retryable: true });
      }),
      fetchBatchSnapshots: vi.fn(async () => {
        throw new ProviderRequestError({
          provider: 'tencent',
          message: 'HTTP 429',
          httpStatus: 429,
          rateLimited: true,
          retryable: true,
        });
      }),
    });

    const secondary = createFakeProvider('sina', {
      fetchBatchSnapshots: vi.fn(async () => {
        throw new ProviderRequestError({
          provider: 'sina',
          message: 'HTTP 403',
          httpStatus: 403,
          rateLimited: true,
          retryable: true,
        });
      }),
    });

    const eastmoney = createFakeProvider('eastmoney', {
      fetchIntradayMinutes: vi.fn(async (symbol) => [
        makeIntradayDay({
          symbol,
          tradeDate: '2026-11-24',
          barCount: 50,
          baseTurnoverPerMin: 2e9,
          source: 'eastmoney',
        }),
        makeIntradayDay({
          symbol,
          tradeDate: '2026-11-23',
          barCount: 240,
          baseTurnoverPerMin: 2e9,
          source: 'eastmoney',
        }),
      ]),
    });

    const hithink = createFakeHithink({
      configured: true,
      snapshots: async (symbols) => {
        const m = new Map<string, QuoteSnapshot>();
        for (const s of symbols) {
          m.set(
            s,
            makeSnapshot({
              symbol: s,
              tradeDate: '2026-11-24',
              timestampMs: nowMs,
              turnover: 102e9,
              source: 'hithink',
            })
          );
        }
        return m;
      },
    });

    const scheduler = new PollingScheduler({
      database: db,
      secretStore: {
        getApiKey: () => 'fake-key',
        getStatus: () => ({ configured: true, source: 'env', encryptionAvailable: true }),
      },
      primarySnapshotProvider: primary,
      secondarySnapshotProvider: secondary,
      hithinkProvider: hithink,
      primaryIntradayProvider: primary,
      secondaryIntradayProvider: eastmoney,
      configuredIntervalSec: 3,
      nowFn: () => nowMs,
      sleepFn: async () => {},
      backfillDelayMs: 0,
    });

    // 首次 tick：腾讯 429 → 切新浪并立即重试 → 新浪 403 → 切同花顺紧急兜底（降频 >=15s）
    const s1 = await scheduler.tickOnce();
    expect(s1.status.activeIntradayProvider).toBe('eastmoney');
    expect(s1.status.activeSnapshotProvider).toBe('hithink');
    expect(s1.status.pollingIntervalSec).toBeGreaterThanOrEqual(15);
    expect(s1.status.degraded).toBe(true);

    // 下一轮同花顺兜底拉取成功，但轮询间隔仍必须保持 >=15s（严禁进入秒级高频）
    const s2 = await scheduler.tickOnce();
    expect(s2.status.activeSnapshotProvider).toBe('hithink');
    expect(s2.status.pollingIntervalSec).toBeGreaterThanOrEqual(15);
    expect(s2.marketTotal.cumTurnover).toBe(204e9);

    db.close();
  });
});
