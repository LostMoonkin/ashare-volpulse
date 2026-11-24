import {
  AlertEngine,
  DEFAULT_ENERGY_CONFIG,
  aggregateMarketTotalAuction,
  aggregateMarketTotalSeries,
  aggregateMarketTotalSnapshot,
  evaluateEnergy,
  getElapsedSecondsInMinute,
  getMarketPhase,
  getPrevTradingDate,
  getShanghaiParts,
  minuteIndexToLabel,
  resolveAlertConfig,
  timestampToMinuteIndex,
  type AlertRuleConfig,
  type EnergyEngineConfig,
  type MarketPhase,
  type SymbolAlertOverride,
  type SymbolTurnoverSnapshot,
} from '../../core';
import {
  CORE_INDICES,
  DEFAULT_POLLING_INTERVAL_SEC,
  DEFAULT_RETENTION_TRADING_DAYS,
  FAILOVER_FAILURE_THRESHOLD,
  HITHINK_FALLBACK_MIN_INTERVAL_SEC,
  MARKET_TOTAL_COMPONENTS,
  MARKET_TOTAL_SYMBOL,
  MAX_BACKOFF_INTERVAL_SEC,
  MAX_POLLING_INTERVAL_SEC,
  MIN_POLLING_INTERVAL_SEC,
  MONITORED_INDEX_NAMES,
  MONITORED_INDEX_SYMBOLS,
  PRIMARY_RECOVERY_PROBE_INTERVAL_MS,
  SETTING_CALENDAR_SYNC_DATE,
} from '../../shared/constants';
import type {
  AlertEventInput,
  CalendarSource,
  CollectorMode,
  CollectorStatus,
  IntradayBarRow,
  IntradayDayData,
  MarketDashboardState,
  MarketTotalState,
  ProviderId,
  QuoteSnapshot,
  SymbolEnergySnapshot,
  TickerSearchResult,
  WatchlistItemRow,
} from '../../shared/types';
import {
  ProviderRequestError,
  defaultSleep,
  type HithinkProvider,
  type MarketDataProvider,
  type SleepLike,
} from '../providers';
import type { AppDatabase } from '../storage/database';
import type { SecretStore } from '../storage/secretStore';

const TOTAL_DAY_BARS = 240;
const NON_TRADING_WAKE_INTERVAL_MS = 30_000;
const MAX_RECENT_ALERTS = 100;

interface PendingMinuteBar {
  minuteIndex: number;
  price: number;
  cumVolume: number;
  cumTurnover: number;
  source: ProviderId;
}

export interface PollingSchedulerOptions {
  database: AppDatabase;
  secretStore: Pick<SecretStore, 'getApiKey' | 'getStatus'>;
  primarySnapshotProvider: MarketDataProvider;
  secondarySnapshotProvider: MarketDataProvider;
  hithinkProvider: HithinkProvider;
  primaryIntradayProvider: MarketDataProvider;
  secondaryIntradayProvider: MarketDataProvider;
  configuredIntervalSec?: number;
  energyConfig?: Partial<EnergyEngineConfig>;
  alertConfig?: Partial<AlertRuleConfig>;
  /** 仅用于测试注入时钟，默认 Date.now */
  nowFn?: () => number;
  /** 仅用于测试注入等待函数 */
  sleepFn?: SleepLike;
  /** 仅用于测试控制单标补齐间隔，默认 150ms */
  backfillDelayMs?: number;
  /** 状态更新回调（主进程用于推送 IPC） */
  onStateUpdate?: (state: MarketDashboardState) => void;
  /** 告警事件派发入口（Phase 4 接入通知与提示音） */
  onAlertTriggered?: (event: AlertEventInput) => void;
}

function clampPollingInterval(sec: number): number {
  if (!Number.isFinite(sec)) return DEFAULT_POLLING_INTERVAL_SEC;
  return Math.max(MIN_POLLING_INTERVAL_SEC, Math.min(MAX_POLLING_INTERVAL_SEC, Math.round(sec)));
}

function hasMinuteGap(bars: readonly { minuteIndex: number }[]): boolean {
  for (let i = 1; i < bars.length; i++) {
    if (bars[i].minuteIndex !== bars[i - 1].minuteIndex + 1) {
      return true;
    }
  }
  return false;
}

function parseWatchlistOverride(item: WatchlistItemRow): SymbolAlertOverride {
  const base: Partial<AlertRuleConfig> = { enabled: item.alertEnabled };
  if (!item.customThresholdsJson) return base;
  try {
    const parsed = JSON.parse(item.customThresholdsJson) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return base;
    return {
      ...parsed,
      enabled: item.alertEnabled,
    } as SymbolAlertOverride;
  } catch {
    return base;
  }
}

/**
 * 混合双源行情采集与自适应分层调度器：
 * - 启动/跨日加载交易日历（SQLite 缓存 → 同花顺 → 公开分时推断降级）
 * - 自动按需补齐昨日完整 240 分钟及今日已过分钟并落盘 SQLite（绝不补零）
 * - 交易时段按配置周期批量轮询 5 指数 + 实时自选股，调用 src/core/ 计算能量与告警
 * - 遇错误或 429/403 指数退避并自动主备切换（腾讯 → 新浪 → 同花顺低频兜底），主源恢复后回切与回落
 * - 午休、盘后、休市自动停止高频轮询并进入复盘模式，收盘后执行 30 交易日滚动清理
 */
export class PollingScheduler {
  private readonly db: AppDatabase;
  private readonly primarySnapshot: MarketDataProvider;
  private readonly secondarySnapshot: MarketDataProvider;
  private readonly hithink: HithinkProvider;
  private readonly primaryIntraday: MarketDataProvider;
  private readonly secondaryIntraday: MarketDataProvider;
  private readonly nowFn: () => number;
  private readonly sleepFn: SleepLike;
  private readonly backfillDelayMs: number;
  private readonly onStateUpdate?: (state: MarketDashboardState) => void;
  private readonly onAlertTriggered?: (event: AlertEventInput) => void;

  private readonly alertEngine: AlertEngine;
  private energyConfig: EnergyEngineConfig;
  private configuredIntervalSec: number;
  private effectiveIntervalSec: number;

  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pollInFlight: Promise<MarketDashboardState> | null = null;

  private openTradingDays: string[] = [];
  private openTradingDaySet = new Set<string>();
  private calendarSource: CalendarSource = 'sqlite_cache';
  private calendarDegraded = false;
  private initializedForDate: string | null = null;
  private lastPrunedDate: string | null = null;

  private displayTradeDate: string | null = null;
  private prevTradeDate: string | null = null;
  private mode: CollectorMode = 'IDLE';
  private lastPhase: MarketPhase = 'CLOSED_DAY';

  private activeSnapshotProvider: ProviderId = 'tencent';
  private activeIntradayProvider: ProviderId | null = null;
  private consecutiveFailures = 0;
  private lastPrimaryProbeAt = 0;
  private lastUpdatedAt: number | null = null;
  private lastLatencyMs: number | null = null;

  private readonly latestSnapshots = new Map<string, QuoteSnapshot>();
  private readonly todayBars = new Map<string, IntradayBarRow[]>();
  private readonly prevBars = new Map<string, IntradayBarRow[]>();
  private readonly todayAuctions = new Map<string, { openPrice: number; auctionTurnover: number }>();
  private readonly prevAuctions = new Map<string, { openPrice: number; auctionTurnover: number }>();
  private readonly pendingBars = new Map<string, PendingMinuteBar>();
  private readonly backfilledKeys = new Set<string>();
  private readonly intradaySourceBySymbol = new Map<string, ProviderId>();
  private readonly recentAlerts: AlertEventInput[] = [];
  private latestState: MarketDashboardState | null = null;

  constructor(options: PollingSchedulerOptions) {
    this.db = options.database;
    this.primarySnapshot = options.primarySnapshotProvider;
    this.secondarySnapshot = options.secondarySnapshotProvider;
    this.hithink = options.hithinkProvider;
    this.primaryIntraday = options.primaryIntradayProvider;
    this.secondaryIntraday = options.secondaryIntradayProvider;
    this.nowFn = options.nowFn ?? (() => Date.now());
    this.sleepFn = options.sleepFn ?? defaultSleep;
    this.backfillDelayMs = options.backfillDelayMs ?? 150;
    this.onStateUpdate = options.onStateUpdate;
    this.onAlertTriggered = options.onAlertTriggered;

    this.configuredIntervalSec = clampPollingInterval(
      options.configuredIntervalSec ?? DEFAULT_POLLING_INTERVAL_SEC
    );
    this.effectiveIntervalSec = this.configuredIntervalSec;
    this.energyConfig = {
      ...DEFAULT_ENERGY_CONFIG,
      ...(options.energyConfig ?? {}),
    };
    this.alertEngine = new AlertEngine(options.alertConfig);
  }

  /** 启动调度器并立即执行一次初始化与状态计算 */
  async start(): Promise<MarketDashboardState> {
    this.running = true;
    const state = await this.tickOnce();
    this.scheduleNextTick();
    return state;
  }

  /** 停止所有定时轮询并落盘尚未闭合的待提交分钟线 */
  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.flushAllPendingBars();
  }

  getLatestState(): MarketDashboardState | null {
    return this.latestState;
  }

  updatePollingInterval(intervalSec: number): void {
    this.configuredIntervalSec = clampPollingInterval(intervalSec);
    if (this.activeSnapshotProvider !== 'hithink') {
      this.effectiveIntervalSec =
        this.consecutiveFailures > 0
          ? Math.max(this.configuredIntervalSec, this.effectiveIntervalSec)
          : this.configuredIntervalSec;
    }
    if (this.running) {
      this.scheduleNextTick();
    }
  }

  updateEnergyConfig(next: Partial<EnergyEngineConfig>): void {
    this.energyConfig = {
      ...this.energyConfig,
      ...next,
    };
  }

  updateAlertConfig(next: Partial<AlertRuleConfig>): void {
    this.alertEngine.updateGlobalConfig(next);
  }

  /** 按优先级执行标的搜索（同花顺权威优先 → 东财快速联想 → 腾讯兜底） */
  async searchTickers(keyword: string, limit = 10): Promise<TickerSearchResult[]> {
    const trimmed = keyword.trim();
    if (!trimmed) return [];

    if (this.hithink.isConfigured()) {
      try {
        const res = await this.hithink.searchTickers(trimmed, limit);
        if (res.length > 0) return res;
      } catch {
        // 降级至公开联想源
      }
    }

    try {
      const emRes = await this.secondaryIntraday.searchTickers(trimmed, limit);
      if (emRes.length > 0) return emRes;
    } catch {
      // 继续降级至腾讯
    }

    try {
      return await this.primarySnapshot.searchTickers(trimmed, limit);
    } catch {
      return [];
    }
  }

  /** 立即执行一次完整周期（初始化/跨日检查 → 按需补齐 → 交易时段拉快照或非交易时段复盘） */
  async tickOnce(): Promise<MarketDashboardState> {
    if (this.pollInFlight) {
      return this.pollInFlight;
    }

    const run = this.executeTick().finally(() => {
      this.pollInFlight = null;
    });
    this.pollInFlight = run;
    return run;
  }

  private scheduleNextTick(): void {
    if (!this.running) return;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    // 盘后与非交易日停止高频轮询，进入低功耗复盘模式（不再定时拉取快照）
    if (this.lastPhase === 'POST_MARKET' || this.lastPhase === 'CLOSED_DAY') {
      return;
    }

    // 午休与盘前不跑高频快照，仅做轻量唤醒检查以便开盘自动切入 LIVE
    const delayMs =
      this.mode === 'LIVE' ? this.effectiveIntervalSec * 1000 : NON_TRADING_WAKE_INTERVAL_MS;

    this.timer = setTimeout(() => {
      void this.tickOnce().finally(() => {
        this.scheduleNextTick();
      });
    }, delayMs);
  }

  private async executeTick(): Promise<MarketDashboardState> {
    const nowMs = this.nowFn();
    const { dateStr: todayStr } = getShanghaiParts(nowMs);

    // 1. 首次启动或跨自然日时加载/刷新交易日历并重置日内缓存
    if (this.initializedForDate !== todayStr) {
      await this.initializeCalendarForDate(todayStr);
      this.initializedForDate = todayStr;
      this.backfilledKeys.clear();
      this.pendingBars.clear();
      this.latestSnapshots.clear();
      this.alertEngine.resetCooldowns();
    }

    // 2. 判定当前市场阶段、展示交易日与运行模式
    const prevPhase = this.lastPhase;
    const phase = getMarketPhase(nowMs, this.openTradingDaySet);
    this.lastPhase = phase;

    const { displayDate, prevDate, mode } = this.resolveDatesAndMode(todayStr, phase);
    this.displayTradeDate = displayDate;
    this.prevTradeDate = prevDate;
    this.mode = mode;

    // 从连续交易阶段进入午休或盘后时，先落盘所有待闭合分钟线
    if (
      (prevPhase === 'MORNING_SESSION' || prevPhase === 'AFTERNOON_SESSION') &&
      (phase === 'LUNCH_BREAK' || phase === 'POST_MARKET')
    ) {
      this.flushAllPendingBars();
    }

    // 3. 获取最新监控标的列表（5 指数 + 实时数据库自选股，增删无需重启）
    const watchlistItems = this.db.getWatchlist();
    const monitoredSymbols = this.collectMonitoredSymbols(watchlistItems);
    const nameLookup = this.buildNameLookup(watchlistItems);

    // 4. 检查 SQLite 缓存并一次性补齐缺失的昨日 240 分钟与今日已过分钟
    await this.ensureIntradayBackfilled(monitoredSymbols, nowMs, phase);

    // 5. 交易时段执行批量快照拉取与告警评估；非交易时段零高频请求，直接复盘
    if (mode === 'LIVE') {
      await this.pollLiveSnapshots(monitoredSymbols, nameLookup, nowMs, phase);
    }

    // 6. 盘后触发一次 30 交易日滚动清理（每日最多一次）
    if (phase === 'POST_MARKET' && displayDate && this.lastPrunedDate !== displayDate) {
      this.db.pruneOlderThanTradingDays(DEFAULT_RETENTION_TRADING_DAYS, displayDate);
      this.lastPrunedDate = displayDate;
    }

    // 7. 调用 src/core/ 引擎计算最新全量看板状态并推送回调
    const state = this.buildDashboardState(watchlistItems, nowMs, phase);
    this.latestState = state;
    this.onStateUpdate?.(state);
    return state;
  }

  private async initializeCalendarForDate(todayStr: string): Promise<void> {
    const cachedSyncDate = this.db.getSetting<string>(SETTING_CALENDAR_SYNC_DATE);
    const cachedOpenDays = this.db.getTradingDays(true).map((d) => d.date);

    // 1. SQLite 当日缓存有效 → 直接使用
    if (cachedSyncDate === todayStr && cachedOpenDays.length > 0) {
      this.setOpenTradingDays(cachedOpenDays, 'sqlite_cache', false);
      return;
    }

    // 2. 配置了同花顺 Key → 拉取近一年权威交易日历并缓存
    if (this.hithink.isConfigured()) {
      try {
        const fetched = await this.hithink.fetchTradingDays();
        if (fetched.length > 0) {
          this.db.upsertTradingDays(fetched);
          this.db.setSetting(SETTING_CALENDAR_SYNC_DATE, todayStr);
          const openDays = fetched.filter((d) => d.isOpen).map((d) => d.date);
          this.setOpenTradingDays(openDays, 'hithink', false);
          return;
        }
      } catch {
        // 同花顺拉取失败，回落至已有缓存或公开分时推断
      }
    }

    // 3. 已有旧缓存 → 降级复用旧缓存
    if (cachedOpenDays.length > 0) {
      this.setOpenTradingDays(cachedOpenDays, 'sqlite_cache', true);
      return;
    }

    // 4. 无缓存且无 Key / 失败 → 由公开源 2 日分时推断最近交易日，标记日历降级
    const inferredDates = await this.inferTradingDatesFromPublicIntraday();
    this.setOpenTradingDays(inferredDates, 'inferred_degraded', true);
  }

  private setOpenTradingDays(
    openDays: readonly string[],
    source: CalendarSource,
    degraded: boolean
  ): void {
    const uniqueSorted = [...new Set(openDays)].sort((a, b) => a.localeCompare(b));
    this.openTradingDays = uniqueSorted;
    this.openTradingDaySet = new Set(uniqueSorted);
    this.calendarSource = source;
    this.calendarDegraded = degraded;
  }

  private async inferTradingDatesFromPublicIntraday(): Promise<string[]> {
    const dayLists = await this.fetchIntradayWithFallback('000001.SH', 5);
    if (!dayLists) return [];
    this.persistIntradayDays(dayLists);
    return dayLists.map((d) => d.tradeDate).sort((a, b) => a.localeCompare(b));
  }

  private resolveDatesAndMode(
    todayStr: string,
    phase: MarketPhase
  ): { displayDate: string | null; prevDate: string | null; mode: CollectorMode } {
    if (
      phase === 'OPEN_AUCTION' ||
      phase === 'AUCTION_GAP' ||
      phase === 'MORNING_SESSION' ||
      phase === 'AFTERNOON_SESSION'
    ) {
      return {
        displayDate: todayStr,
        prevDate: getPrevTradingDate(todayStr, this.openTradingDaySet),
        mode: 'LIVE',
      };
    }

    if (phase === 'LUNCH_BREAK' || phase === 'POST_MARKET') {
      return {
        displayDate: todayStr,
        prevDate: getPrevTradingDate(todayStr, this.openTradingDaySet),
        mode: 'REPLAY',
      };
    }

    // CLOSED_DAY 或 PRE_MARKET（09:15 之前）：复盘最近一个已完成交易日
    let latestCompleted: string | null = null;
    for (const d of this.openTradingDays) {
      if (d < todayStr) {
        latestCompleted = d;
      }
    }
    return {
      displayDate: latestCompleted,
      prevDate: latestCompleted ? getPrevTradingDate(latestCompleted, this.openTradingDaySet) : null,
      mode: 'REPLAY',
    };
  }

  private collectMonitoredSymbols(watchlistItems: readonly WatchlistItemRow[]): string[] {
    const result: string[] = [...MONITORED_INDEX_SYMBOLS];
    const seen = new Set<string>(result);
    for (const item of watchlistItems) {
      const sym = item.symbol.trim().toUpperCase();
      if (sym && !seen.has(sym)) {
        seen.add(sym);
        result.push(sym);
      }
    }
    return result;
  }

  private buildNameLookup(watchlistItems: readonly WatchlistItemRow[]): Map<string, string> {
    const map = new Map<string, string>(Object.entries(MONITORED_INDEX_NAMES));
    for (const item of watchlistItems) {
      map.set(item.symbol.trim().toUpperCase(), item.name);
    }
    return map;
  }

  private loadSymbolFromDb(symbol: string): void {
    if (this.displayTradeDate) {
      this.todayBars.set(symbol, this.db.getIntradayBars(symbol, this.displayTradeDate));
      const a = this.db.getAuctionSnapshot(symbol, this.displayTradeDate);
      if (a) {
        this.todayAuctions.set(symbol, {
          openPrice: a.openPrice,
          auctionTurnover: a.auctionTurnover,
        });
      }
    }
    if (this.prevTradeDate) {
      this.prevBars.set(symbol, this.db.getIntradayBars(symbol, this.prevTradeDate));
      const pa = this.db.getAuctionSnapshot(symbol, this.prevTradeDate);
      if (pa) {
        this.prevAuctions.set(symbol, {
          openPrice: pa.openPrice,
          auctionTurnover: pa.auctionTurnover,
        });
      }
    }
  }

  private needsBackfill(symbol: string, nowMs: number, phase: MarketPhase): boolean {
    if (!this.displayTradeDate) return false;
    const key = `${symbol}:${this.displayTradeDate}:${this.prevTradeDate ?? ''}`;
    if (this.backfilledKeys.has(key)) return false;

    const prevList = this.prevBars.get(symbol) ?? [];
    if (this.prevTradeDate && prevList.length < TOTAL_DAY_BARS) {
      return true;
    }

    const todayList = this.todayBars.get(symbol) ?? [];
    if (this.mode === 'REPLAY') {
      if (phase === 'LUNCH_BREAK') {
        return todayList.length < 120;
      }
      return todayList.length < TOTAL_DAY_BARS;
    }

    const currentMinuteIndex = timestampToMinuteIndex(nowMs);
    if (currentMinuteIndex !== null && currentMinuteIndex > 0) {
      const expectedClosedCount = currentMinuteIndex; // 0 .. currentMinuteIndex-1
      if (todayList.length < expectedClosedCount) {
        return true;
      }
    }

    if (
      (phase === 'MORNING_SESSION' || phase === 'AFTERNOON_SESSION') &&
      !this.todayAuctions.has(symbol)
    ) {
      return true;
    }

    return false;
  }

  private async ensureIntradayBackfilled(
    symbols: readonly string[],
    nowMs: number,
    phase: MarketPhase
  ): Promise<void> {
    const missing: string[] = [];

    for (const sym of symbols) {
      this.loadSymbolFromDb(sym);
      if (this.needsBackfill(sym, nowMs, phase)) {
        missing.push(sym);
      } else if (this.displayTradeDate) {
        this.backfilledKeys.add(`${sym}:${this.displayTradeDate}:${this.prevTradeDate ?? ''}`);
      }
    }

    if (missing.length === 0) return;

    // 限制并发度为 2、批次间间隔 150ms，避免触发上游限流（docs/DATA_SOURCES.md §5.2）
    const concurrency = 2;
    for (let i = 0; i < missing.length; i += concurrency) {
      const batch = missing.slice(i, i + concurrency);
      await Promise.all(
        batch.map(async (sym) => {
          const days = await this.fetchIntradayWithFallback(sym, 2);
          if (days && days.length > 0) {
            this.persistIntradayDays(days);
            this.intradaySourceBySymbol.set(sym, days[0].source);
            this.loadSymbolFromDb(sym);
            if (this.displayTradeDate) {
              this.backfilledKeys.add(
                `${sym}:${this.displayTradeDate}:${this.prevTradeDate ?? ''}`
              );
            }
          }
        })
      );
      if (i + concurrency < missing.length && this.backfillDelayMs > 0) {
        await this.sleepFn(this.backfillDelayMs);
      }
    }
  }

  private async fetchIntradayWithFallback(
    symbol: string,
    days: number
  ): Promise<IntradayDayData[] | null> {
    try {
      const res = await this.primaryIntraday.fetchIntradayMinutes(symbol, days);
      if (res.length > 0) {
        this.activeIntradayProvider = this.primaryIntraday.id;
        return res;
      }
    } catch {
      // 主分时源失败，自动回退至备用分时源（东财 push2his）
    }

    try {
      const fallback = await this.secondaryIntraday.fetchIntradayMinutes(symbol, days);
      if (fallback.length > 0) {
        this.activeIntradayProvider = this.secondaryIntraday.id;
        return fallback;
      }
    } catch {
      // 双分时源均失败时保持现状，绝不补零或生成合成数据
    }

    return null;
  }

  private persistIntradayDays(days: readonly IntradayDayData[]): void {
    const nowMs = this.nowFn();
    for (const day of days) {
      if (day.bars.length > 0) {
        this.db.upsertIntradayBars(day.bars);
      }
      if (day.auction) {
        this.db.upsertAuctionSnapshot({
          symbol: day.symbol,
          tradeDate: day.tradeDate,
          openPrice: day.auction.openPrice,
          auctionTurnover: day.auction.auctionTurnover,
          capturedAt: nowMs,
        });
      }
    }
  }

  private getProviderById(id: ProviderId): MarketDataProvider {
    if (id === this.primarySnapshot.id) return this.primarySnapshot;
    if (id === this.secondarySnapshot.id) return this.secondarySnapshot;
    return this.hithink;
  }

  private async maybeProbePrimaryRecovery(nowMs: number): Promise<void> {
    if (this.activeSnapshotProvider === this.primarySnapshot.id) return;
    if (nowMs - this.lastPrimaryProbeAt < PRIMARY_RECOVERY_PROBE_INTERVAL_MS) return;

    this.lastPrimaryProbeAt = nowMs;
    const health = await this.primarySnapshot.healthCheck();
    if (health.ok) {
      this.activeSnapshotProvider = this.primarySnapshot.id;
      this.consecutiveFailures = 0;
      this.effectiveIntervalSec = Math.max(
        this.configuredIntervalSec,
        Math.floor(this.effectiveIntervalSec / 2)
      );
    }
  }

  private async pollLiveSnapshots(
    symbols: readonly string[],
    nameLookup: ReadonlyMap<string, string>,
    nowMs: number,
    phase: MarketPhase
  ): Promise<void> {
    await this.maybeProbePrimaryRecovery(nowMs);

    const attemptPoll = async (providerId: ProviderId): Promise<Map<string, QuoteSnapshot>> => {
      const provider = this.getProviderById(providerId);
      const started = performance.now();
      const snapshots = await provider.fetchBatchSnapshots(symbols, nameLookup);
      this.lastLatencyMs = Math.round((performance.now() - started) * 10) / 10;
      this.lastUpdatedAt = nowMs;
      return snapshots;
    };

    try {
      const snapshots = await attemptPoll(this.activeSnapshotProvider);
      this.handlePollSuccess(snapshots, nowMs, phase);
      return;
    } catch (err) {
      const switched = this.handlePollFailure(err, nowMs);
      if (switched) {
        // 刚刚触发主备切换时立即用新备源补拉一次，避免多等一个周期
        try {
          const fallbackSnapshots = await attemptPoll(this.activeSnapshotProvider);
          this.handlePollSuccess(fallbackSnapshots, nowMs, phase);
        } catch (fallbackErr) {
          this.handlePollFailure(fallbackErr, nowMs);
        }
      }
    }
  }

  private handlePollSuccess(
    snapshots: Map<string, QuoteSnapshot>,
    nowMs: number,
    phase: MarketPhase
  ): void {
    this.consecutiveFailures = 0;

    if (this.activeSnapshotProvider === 'hithink') {
      this.effectiveIntervalSec = Math.max(
        HITHINK_FALLBACK_MIN_INTERVAL_SEC,
        this.configuredIntervalSec
      );
    } else if (this.effectiveIntervalSec > this.configuredIntervalSec) {
      this.effectiveIntervalSec = Math.max(
        this.configuredIntervalSec,
        Math.floor(this.effectiveIntervalSec / 2)
      );
    }

    for (const [symbol, snap] of snapshots) {
      this.latestSnapshots.set(symbol, snap);

      if (!this.displayTradeDate || snap.tradeDate !== this.displayTradeDate) {
        continue;
      }

      // 仅在 09:25–09:29 集合竞价间隙捕获开盘集合竞价并落盘 auction_snapshots
      // （盘中连续竞价阶段不可把累计成交额误存为开盘竞价额）
      if (phase === 'AUCTION_GAP' && !this.todayAuctions.has(symbol) && snap.turnover > 0) {
        const auction = {
          openPrice: snap.open > 0 ? snap.open : snap.price,
          auctionTurnover: snap.turnover,
        };
        this.todayAuctions.set(symbol, auction);
        this.db.upsertAuctionSnapshot({
          symbol,
          tradeDate: this.displayTradeDate,
          openPrice: auction.openPrice,
          auctionTurnover: auction.auctionTurnover,
          capturedAt: nowMs,
        });
      }

      // 连续竞价阶段维护分钟聚合并在分钟闭合时落盘 intraday_bars
      const minuteIndex = timestampToMinuteIndex(snap.timestampMs);
      if (minuteIndex === null) continue;

      const prevPending = this.pendingBars.get(symbol);
      if (prevPending && prevPending.minuteIndex < minuteIndex) {
        this.persistClosedPendingBar(symbol, prevPending);
      }

      const nextPending: PendingMinuteBar = {
        minuteIndex,
        price: snap.price,
        cumVolume: snap.volumeShares,
        cumTurnover: snap.turnover,
        source: snap.source,
      };
      this.pendingBars.set(symbol, nextPending);

      // 11:30:00 或 15:00:00 闭合点立即落盘
      if (getElapsedSecondsInMinute(snap.timestampMs) === 60) {
        this.persistClosedPendingBar(symbol, nextPending);
        this.pendingBars.delete(symbol);
      }
    }
  }

  /** 返回是否发生了主备源切换 */
  private handlePollFailure(err: unknown, nowMs: number): boolean {
    this.consecutiveFailures += 1;
    const isRateLimited = err instanceof ProviderRequestError && err.rateLimited;

    // 指数退避翻倍（3s → 6s → 12s → 24s → 30s 上限）
    this.effectiveIntervalSec = Math.min(
      MAX_BACKOFF_INTERVAL_SEC,
      Math.max(this.configuredIntervalSec, this.effectiveIntervalSec) * 2
    );

    const shouldFailover = isRateLimited || this.consecutiveFailures >= FAILOVER_FAILURE_THRESHOLD;
    if (!shouldFailover) {
      return false;
    }

    const nextProvider = this.selectNextFallbackProvider(this.activeSnapshotProvider);
    if (!nextProvider || nextProvider === this.activeSnapshotProvider) {
      return false;
    }

    this.activeSnapshotProvider = nextProvider;
    this.consecutiveFailures = 0;
    this.lastPrimaryProbeAt = nowMs;

    if (nextProvider === 'hithink') {
      this.effectiveIntervalSec = Math.max(
        this.effectiveIntervalSec,
        HITHINK_FALLBACK_MIN_INTERVAL_SEC
      );
    }

    return true;
  }

  private selectNextFallbackProvider(current: ProviderId): ProviderId | null {
    if (current === this.primarySnapshot.id) {
      return this.secondarySnapshot.id;
    }
    if (current === this.secondarySnapshot.id && this.hithink.isConfigured()) {
      return 'hithink';
    }
    return null;
  }

  private persistClosedPendingBar(symbol: string, pending: PendingMinuteBar): void {
    if (!this.displayTradeDate) return;

    const existing = this.todayBars.get(symbol) ?? [];
    const prevBar = existing.find((b) => b.minuteIndex === pending.minuteIndex - 1);
    const auction = this.todayAuctions.get(symbol);

    let barTurnover: number;
    if (prevBar) {
      barTurnover = Math.max(0, pending.cumTurnover - prevBar.cumTurnover);
    } else if (pending.minuteIndex === 0 && auction) {
      barTurnover = Math.max(0, pending.cumTurnover - auction.auctionTurnover);
    } else if (existing.length > 0) {
      const lastBefore = [...existing]
        .reverse()
        .find((b) => b.minuteIndex < pending.minuteIndex);
      barTurnover = lastBefore
        ? Math.max(0, pending.cumTurnover - lastBefore.cumTurnover)
        : pending.cumTurnover;
    } else {
      barTurnover = pending.cumTurnover;
    }

    const bar: IntradayBarRow = {
      symbol,
      tradeDate: this.displayTradeDate,
      minuteIndex: pending.minuteIndex,
      minuteStr: minuteIndexToLabel(pending.minuteIndex),
      price: pending.price,
      cumVolume: pending.cumVolume,
      cumTurnover: pending.cumTurnover,
      barTurnover,
      source: pending.source,
    };

    this.db.upsertIntradayBars([bar]);

    const idx = existing.findIndex((b) => b.minuteIndex === bar.minuteIndex);
    const updated = [...existing];
    if (idx >= 0) {
      updated[idx] = bar;
    } else {
      updated.push(bar);
      updated.sort((a, b) => a.minuteIndex - b.minuteIndex);
    }
    this.todayBars.set(symbol, updated);
  }

  private flushAllPendingBars(): void {
    for (const [symbol, pending] of this.pendingBars) {
      this.persistClosedPendingBar(symbol, pending);
    }
    this.pendingBars.clear();
  }

  private buildDashboardState(
    watchlistItems: readonly WatchlistItemRow[],
    nowMs: number,
    phase: MarketPhase
  ): MarketDashboardState {
    const degradedReasons: string[] = [];

    if (this.calendarDegraded) {
      degradedReasons.push(`CALENDAR_${this.calendarSource.toUpperCase()}`);
    }
    if (this.activeSnapshotProvider === 'hithink') {
      degradedReasons.push('SNAPSHOT_HITHINK_EMERGENCY_FALLBACK');
    }
    if (this.consecutiveFailures > 0) {
      degradedReasons.push(`SNAPSHOT_FAILURES_${this.consecutiveFailures}`);
    }

    const currentMinuteIndex = timestampToMinuteIndex(nowMs);
    const currentElapsedSec = getElapsedSecondsInMinute(nowMs) ?? 60;

    // 1. 计算沪深两市总成交额（严格使用 000001.SH + 399106.SZ）
    const marketTotal = this.buildMarketTotalState(nowMs, currentMinuteIndex, currentElapsedSec);
    if (marketTotal.degraded) {
      degradedReasons.push(`MARKET_TOTAL_${marketTotal.degradedReason ?? 'DEGRADED'}`);
    }

    // 2. 计算四大核心指数
    const indices = CORE_INDICES.map((meta) =>
      this.buildSymbolState({
        symbol: meta.symbol,
        name: meta.name,
        isIndex: true,
        scope: meta.scope,
        scopeDetail: meta.scopeDetail,
        symbolOverride: null,
        nowMs,
        currentMinuteIndex,
        currentElapsedSec,
      })
    );

    // 3. 计算用户自选股
    const watchlist = watchlistItems.map((item) =>
      this.buildSymbolState({
        symbol: item.symbol.trim().toUpperCase(),
        name: item.name,
        isIndex: false,
        symbolOverride: parseWatchlistOverride(item),
        nowMs,
        currentMinuteIndex,
        currentElapsedSec,
      })
    );

    const staleThresholdMs = Math.max(15_000, this.effectiveIntervalSec * 3_000);
    const stale =
      this.mode === 'LIVE' &&
      (this.lastUpdatedAt === null || nowMs - this.lastUpdatedAt > staleThresholdMs);
    if (stale) {
      degradedReasons.push('DATA_STALE');
    }

    const status: CollectorStatus = {
      mode: this.mode,
      phase,
      tradeDate: this.displayTradeDate,
      prevTradeDate: this.prevTradeDate,
      activeSnapshotProvider: this.mode === 'LIVE' ? this.activeSnapshotProvider : null,
      activeIntradayProvider: this.activeIntradayProvider,
      calendarSource: this.calendarSource,
      calendarDegraded: this.calendarDegraded,
      pollingIntervalSec: this.effectiveIntervalSec,
      configuredIntervalSec: this.configuredIntervalSec,
      lastUpdatedAt: this.lastUpdatedAt,
      lastLatencyMs: this.lastLatencyMs,
      consecutiveFailures: this.consecutiveFailures,
      stale,
      degraded: degradedReasons.length > 0,
      degradedReasons,
    };

    return {
      status,
      marketTotal,
      indices,
      watchlist,
      recentAlerts: [...this.recentAlerts],
    };
  }

  private buildMarketTotalState(
    nowMs: number,
    currentMinuteIndex: number | null,
    currentElapsedSec: number
  ): MarketTotalState {
    const [shSym, szSym] = MARKET_TOTAL_COMPONENTS;
    const shTodayBars = this.todayBars.get(shSym) ?? [];
    const szTodayBars = this.todayBars.get(szSym) ?? [];
    const shPrevBars = this.prevBars.get(shSym) ?? [];
    const szPrevBars = this.prevBars.get(szSym) ?? [];

    const todayAggSeries = aggregateMarketTotalSeries(shTodayBars, szTodayBars);
    const prevAggSeries = aggregateMarketTotalSeries(shPrevBars, szPrevBars);

    const todayAuctionInputs = [shSym, szSym]
      .map((sym) => {
        const a = this.todayAuctions.get(sym);
        return a && this.displayTradeDate
          ? { symbol: sym, tradeDate: this.displayTradeDate, auctionTurnover: a.auctionTurnover }
          : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    const todayAggAuction = aggregateMarketTotalAuction(todayAuctionInputs);

    const prevAuctionInputs = [shSym, szSym]
      .map((sym) => {
        const a = this.prevAuctions.get(sym);
        return a && this.prevTradeDate
          ? { symbol: sym, tradeDate: this.prevTradeDate, auctionTurnover: a.auctionTurnover }
          : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    const prevAggAuction = aggregateMarketTotalAuction(prevAuctionInputs);

    const prevFullDayTurnover =
      prevAggSeries.bars.length > 0
        ? prevAggSeries.bars[prevAggSeries.bars.length - 1].cumTurnover
        : null;

    let cumTurnover: number | null = null;
    let shTurnover: number | null = null;
    let szTurnover: number | null = null;
    let degraded = false;
    let degradedReason: string | null = null;
    let evalMinuteIndex: number | null = null;
    let evalElapsedSec = 60;

    const seriesHasGap = hasMinuteGap(todayAggSeries.bars) || hasMinuteGap(prevAggSeries.bars);

    if (this.mode === 'LIVE') {
      const shSnap = this.latestSnapshots.get(shSym);
      const szSnap = this.latestSnapshots.get(szSym);
      const snapInputs: SymbolTurnoverSnapshot[] = [];
      if (shSnap) {
        snapInputs.push({
          symbol: shSnap.symbol,
          tradeDate: shSnap.tradeDate,
          minuteIndex: timestampToMinuteIndex(shSnap.timestampMs),
          timestampMs: shSnap.timestampMs,
          cumTurnover: shSnap.turnover,
        });
      }
      if (szSnap) {
        snapInputs.push({
          symbol: szSnap.symbol,
          tradeDate: szSnap.tradeDate,
          minuteIndex: timestampToMinuteIndex(szSnap.timestampMs),
          timestampMs: szSnap.timestampMs,
          cumTurnover: szSnap.turnover,
        });
      }

      const aggSnap = aggregateMarketTotalSnapshot(snapInputs);
      cumTurnover = aggSnap.cumTurnover;
      shTurnover = aggSnap.shTurnover;
      szTurnover = aggSnap.szTurnover;
      degraded =
        aggSnap.degraded ||
        todayAggSeries.missingShMinutes.length > 0 ||
        todayAggSeries.missingSzMinutes.length > 0 ||
        seriesHasGap;
      degradedReason = aggSnap.reason ?? (seriesHasGap ? 'SERIES_GAP' : null);
      evalMinuteIndex = aggSnap.minuteIndex ?? currentMinuteIndex;
      evalElapsedSec =
        aggSnap.timestampMs !== null
          ? (getElapsedSecondsInMinute(aggSnap.timestampMs) ?? currentElapsedSec)
          : currentElapsedSec;
    } else {
      // REPLAY 模式：采用最新已聚合收盘分钟
      const lastBar =
        todayAggSeries.bars.length > 0
          ? todayAggSeries.bars[todayAggSeries.bars.length - 1]
          : null;
      cumTurnover = lastBar?.cumTurnover ?? null;
      shTurnover = lastBar?.shCumTurnover ?? null;
      szTurnover = lastBar?.szCumTurnover ?? null;
      degraded = todayAggSeries.degraded || seriesHasGap || lastBar === null;
      degradedReason =
        lastBar === null
          ? 'NO_SERIES_DATA'
          : todayAggSeries.degraded
            ? 'SERIES_INCOMPLETE'
            : seriesHasGap
              ? 'SERIES_GAP'
              : null;
      evalMinuteIndex = lastBar?.minuteIndex ?? null;
      evalElapsedSec = 60;
    }

    const alertCfg = resolveAlertConfig(this.alertEngine.getGlobalConfig());
    const metrics =
      evalMinuteIndex !== null
        ? evaluateEnergy({
            todaySeries: todayAggSeries.bars,
            prevSeries: prevAggSeries.bars,
            minuteIndex: evalMinuteIndex,
            currentTodayCumTurnover: cumTurnover,
            elapsedSeconds: evalElapsedSec,
            prevFullDayTurnover,
            prevAuctionTurnover: prevAggAuction.auctionTurnover,
            config: {
              ...this.energyConfig,
              slopeWindow: alertCfg.slopeWindow,
            },
          })
        : null;

    if (this.mode === 'LIVE' && metrics && this.displayTradeDate) {
      this.evaluateAndDispatchAlert({
        symbol: MARKET_TOTAL_SYMBOL,
        name: '沪深两市',
        tradeDate: this.displayTradeDate,
        timestampMs: nowMs,
        metrics,
        degraded,
      });
    }

    return {
      symbol: MARKET_TOTAL_SYMBOL,
      name: '沪深两市',
      tradeDate: this.displayTradeDate,
      prevTradeDate: this.prevTradeDate,
      cumTurnover,
      shTurnover,
      szTurnover,
      auctionTurnover: todayAggAuction.auctionTurnover,
      prevAuctionTurnover: prevAggAuction.auctionTurnover,
      prevFullDayTurnover,
      metrics,
      todaySeries: todayAggSeries.bars.map((b) => ({
        minuteIndex: b.minuteIndex,
        cumTurnover: b.cumTurnover,
        barTurnover: b.barTurnover,
      })),
      prevSeries: prevAggSeries.bars.map((b) => ({
        minuteIndex: b.minuteIndex,
        cumTurnover: b.cumTurnover,
        barTurnover: b.barTurnover,
      })),
      degraded,
      degradedReason,
    };
  }

  private buildSymbolState(params: {
    symbol: string;
    name: string;
    isIndex: boolean;
    scope?: SymbolEnergySnapshot['scope'];
    scopeDetail?: string;
    symbolOverride: SymbolAlertOverride | null;
    nowMs: number;
    currentMinuteIndex: number | null;
    currentElapsedSec: number;
  }): SymbolEnergySnapshot {
    const { symbol, name } = params;
    const todaySeries = this.todayBars.get(symbol) ?? [];
    const prevSeries = this.prevBars.get(symbol) ?? [];
    const todayAuction = this.todayAuctions.get(symbol)?.auctionTurnover ?? null;
    const prevAuction = this.prevAuctions.get(symbol)?.auctionTurnover ?? null;
    const prevFullDayTurnover =
      prevSeries.length > 0 ? prevSeries[prevSeries.length - 1].cumTurnover : null;

    const snap = this.latestSnapshots.get(symbol) ?? null;

    // 399006.SZ 跨源口径防跳变检查（docs/DATA_SOURCES.md §2.2）
    const intradaySource = this.intradaySourceBySymbol.get(symbol) ?? prevSeries[0]?.source ?? null;
    const crossSourceMismatch =
      symbol === '399006.SZ' &&
      snap !== null &&
      intradaySource !== null &&
      ((intradaySource === 'tencent' && (snap.source === 'eastmoney' || snap.source === 'hithink')) ||
        (intradaySource === 'eastmoney' && (snap.source === 'tencent' || snap.source === 'sina')));

    let degraded = false;
    let degradedReason: string | null = null;
    let evalMinuteIndex: number | null = null;
    let evalTodayTurnover: number | null = null;
    let evalElapsedSec = 60;

    if (this.mode === 'LIVE') {
      if (!snap || (this.displayTradeDate && snap.tradeDate !== this.displayTradeDate)) {
        degraded = true;
        degradedReason = 'MISSING_OR_STALE_SNAPSHOT';
      } else if (crossSourceMismatch) {
        degraded = true;
        degradedReason = 'CROSS_SOURCE_SCOPE_MISMATCH';
      } else {
        evalMinuteIndex = timestampToMinuteIndex(snap.timestampMs) ?? params.currentMinuteIndex;
        evalTodayTurnover = snap.turnover;
        evalElapsedSec = getElapsedSecondsInMinute(snap.timestampMs) ?? params.currentElapsedSec;
      }
    } else {
      const lastBar = todaySeries.length > 0 ? todaySeries[todaySeries.length - 1] : null;
      if (!lastBar) {
        degraded = true;
        degradedReason = 'NO_SERIES_DATA';
      } else {
        evalMinuteIndex = lastBar.minuteIndex;
        evalTodayTurnover = lastBar.cumTurnover;
        evalElapsedSec = 60;
      }
    }

    if (prevSeries.length === 0) {
      degraded = true;
      degradedReason = degradedReason ?? 'MISSING_PREV_BASELINE';
    } else if (hasMinuteGap(todaySeries) || hasMinuteGap(prevSeries)) {
      degraded = true;
      degradedReason = degradedReason ?? 'MISSING_MINUTES';
    }

    const alertCfg = resolveAlertConfig(this.alertEngine.getGlobalConfig(), params.symbolOverride);
    const metrics =
      evalMinuteIndex !== null && !crossSourceMismatch
        ? evaluateEnergy({
            todaySeries,
            prevSeries,
            minuteIndex: evalMinuteIndex,
            currentTodayCumTurnover: evalTodayTurnover,
            elapsedSeconds: evalElapsedSec,
            prevFullDayTurnover,
            prevAuctionTurnover: prevAuction,
            config: {
              ...this.energyConfig,
              slopeWindow: alertCfg.slopeWindow,
            },
          })
        : null;

    if (this.mode === 'LIVE' && metrics && this.displayTradeDate) {
      this.evaluateAndDispatchAlert({
        symbol,
        name: snap?.name ?? name,
        tradeDate: this.displayTradeDate,
        timestampMs: params.nowMs,
        metrics,
        degraded,
        symbolOverride: params.symbolOverride,
      });
    }

    return {
      symbol,
      name: snap?.name ?? name,
      isIndex: params.isIndex,
      scope: params.scope,
      scopeDetail: params.scopeDetail,
      quote: snap,
      metrics,
      auctionTurnover: todayAuction,
      prevAuctionTurnover: prevAuction,
      prevFullDayTurnover,
      todaySeries,
      prevSeries,
      degraded,
      degradedReason,
    };
  }

  private evaluateAndDispatchAlert(params: {
    symbol: string;
    name: string;
    tradeDate: string;
    timestampMs: number;
    metrics: NonNullable<SymbolEnergySnapshot['metrics']>;
    degraded: boolean;
    symbolOverride?: SymbolAlertOverride | null;
  }): void {
    const res = this.alertEngine.evaluate(params);
    if (!res.triggered || !res.event) return;

    this.recentAlerts.unshift(res.event);
    if (this.recentAlerts.length > MAX_RECENT_ALERTS) {
      this.recentAlerts.length = MAX_RECENT_ALERTS;
    }
    this.onAlertTriggered?.(res.event);
  }
}
