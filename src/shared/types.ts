import type { IndexScopeBadge } from './constants';

/**
 * 前后端共享数据类型与 SQLite 持久化行契约
 */

export type AlertDirection = 'SURGE' | 'SHRINK';

export type ProviderId = 'tencent' | 'sina' | 'eastmoney' | 'hithink';

export type CalendarSource = 'sqlite_cache' | 'hithink' | 'inferred_degraded';

export type CollectorMode = 'LIVE' | 'REPLAY' | 'IDLE';

export type MarketPhaseType =
  | 'PRE_MARKET'
  | 'OPEN_AUCTION'
  | 'AUCTION_GAP'
  | 'MORNING_SESSION'
  | 'LUNCH_BREAK'
  | 'AFTERNOON_SESSION'
  | 'POST_MARKET'
  | 'CLOSED_DAY';

export type VolumeStateType = 'EXPANDING' | 'FLAT' | 'SHRINKING' | 'UNAVAILABLE';

/** 标准化单标的实时快照（金额统一为人民币元，成交量统一为股） */
export interface QuoteSnapshot {
  symbol: string;
  name: string;
  price: number;
  prevClose: number;
  open: number;
  high: number;
  low: number;
  changeAmt: number;
  /** 涨跌幅百分比数值（如 1.46 表示 +1.46%） */
  changePct: number;
  /** 累计成交量（股） */
  volumeShares: number;
  /** 累计成交额（人民币元） */
  turnover: number;
  /** 行情交易日 YYYY-MM-DD */
  tradeDate: string;
  /** 行情时间戳（按北京时间解析的 Unix 毫秒） */
  timestampMs: number;
  source: ProviderId;
}

/** 标准化单日 1 分钟分时基线数据 */
export interface IntradayDayData {
  symbol: string;
  tradeDate: string;
  prevClose: number | null;
  auction: {
    openPrice: number;
    auctionTurnover: number;
  } | null;
  bars: IntradayBarRow[];
  source: ProviderId;
}

/** 标准化标的搜索结果 */
export interface TickerSearchResult {
  symbol: string;
  ticker: string;
  name: string;
  exchange: 'SH' | 'SZ';
  assetType: 'STOCK' | 'INDEX';
  source: ProviderId;
}

/** 单数据源健康检查结果 */
export interface ProviderHealthStatus {
  provider: ProviderId;
  ok: boolean;
  latencyMs: number;
  error: string | null;
}

/** 能量计算指标快照（与 src/core/energyEngine.ts EnergyMetrics 结构同构） */
export interface SymbolEnergyMetricsView {
  minuteIndex: number;
  elapsedSeconds: number;
  todayCumTurnover: number | null;
  prevAlignedCumTurnover: number | null;
  cumDiff: number | null;
  cumRatio: number | null;
  cumRatioPct: number | null;
  predictedFullDayTurnover: number | null;
  volumeState: VolumeStateType;
  slope: number | null;
  windowMultiple: number | null;
  slopeWindow: number;
}

/** 单标的（四大核心指数 / 自选股）看板状态 */
export interface SymbolEnergySnapshot {
  symbol: string;
  name: string;
  isIndex: boolean;
  scope?: IndexScopeBadge;
  scopeDetail?: string;
  quote: QuoteSnapshot | null;
  metrics: SymbolEnergyMetricsView | null;
  auctionTurnover: number | null;
  prevAuctionTurnover: number | null;
  prevFullDayTurnover: number | null;
  todaySeries: IntradayBarRow[];
  prevSeries: IntradayBarRow[];
  degraded: boolean;
  degradedReason: string | null;
}

/** 沪深两市聚合分时点 */
export interface MarketTotalBarPoint {
  minuteIndex: number;
  cumTurnover: number;
  barTurnover: number | null;
}

/** 沪深两市总成交额看板状态 */
export interface MarketTotalState {
  symbol: 'MARKET_TOTAL';
  name: string;
  tradeDate: string | null;
  prevTradeDate: string | null;
  cumTurnover: number | null;
  shTurnover: number | null;
  szTurnover: number | null;
  auctionTurnover: number | null;
  prevAuctionTurnover: number | null;
  prevFullDayTurnover: number | null;
  metrics: SymbolEnergyMetricsView | null;
  todaySeries: MarketTotalBarPoint[];
  prevSeries: MarketTotalBarPoint[];
  degraded: boolean;
  degradedReason: string | null;
}

/** 采集调度器与数据源运行态（向渲染进程暴露） */
export interface CollectorStatus {
  mode: CollectorMode;
  phase: MarketPhaseType;
  tradeDate: string | null;
  prevTradeDate: string | null;
  activeSnapshotProvider: ProviderId | null;
  activeIntradayProvider: ProviderId | null;
  calendarSource: CalendarSource;
  calendarDegraded: boolean;
  pollingIntervalSec: number;
  configuredIntervalSec: number;
  lastUpdatedAt: number | null;
  lastLatencyMs: number | null;
  consecutiveFailures: number;
  stale: boolean;
  degraded: boolean;
  degradedReasons: string[];
}

/** 推送给渲染进程的完整看板状态 */
export interface MarketDashboardState {
  status: CollectorStatus;
  marketTotal: MarketTotalState;
  indices: SymbolEnergySnapshot[];
  watchlist: SymbolEnergySnapshot[];
  recentAlerts: AlertEventInput[];
}

export type SecretSource = 'safeStorage' | 'env' | 'credentialsFile' | 'none';

/** 脱敏后的同花顺 API Key 配置状态（严禁包含任何明文或片段） */
export interface SecretStatus {
  configured: boolean;
  source: SecretSource;
  encryptionAvailable: boolean;
}

/** trading_days 表记录（date 统一采用 YYYY-MM-DD 格式） */
export interface TradingDayRow {
  date: string;
  isOpen: boolean;
}

/** intraday_bars 表记录 */
export interface IntradayBarRow {
  symbol: string;
  tradeDate: string;
  minuteIndex: number;
  minuteStr: string;
  price: number;
  cumVolume: number;
  cumTurnover: number;
  barTurnover: number;
  source: string;
}

/** auction_snapshots 表记录 */
export interface AuctionSnapshotRow {
  symbol: string;
  tradeDate: string;
  openPrice: number;
  auctionTurnover: number;
  capturedAt: number;
}

/** watchlist 表记录 */
export interface WatchlistItemRow {
  symbol: string;
  name: string;
  sortOrder: number;
  alertEnabled: boolean;
  customThresholdsJson: string | null;
}

/** alert_events 表记录（写入时不含 id，读取时包含自增 id） */
export interface AlertEventInput {
  symbol: string;
  name: string;
  tradeDate: string;
  minuteIndex: number;
  direction: AlertDirection;
  slope: number;
  windowMultiple: number;
  cumRatio: number;
  message: string;
  createdAt: number;
}

export interface AlertEventRow extends AlertEventInput {
  id: number;
}

/** 经主进程告警通道广播给渲染进程的完整告警载荷 */
export interface AlertDispatchPayload extends AlertEventRow {
  /** 是否为开发态模拟测试事件 */
  isSimulated: boolean;
  /** 派发瞬间应用是否处于静音状态（静音时渲染进程不播放提示音） */
  muted: boolean;
}

/** 窗口左上角屏幕坐标 */
export interface WindowPosition {
  x: number;
  y: number;
}

/** 详情浮层页签 */
export type DetailTab = 'chart' | 'watchlist' | 'alerts' | 'settings';

/** 打开详情浮层的可选参数 */
export interface OpenDetailOptions {
  symbol?: string;
  tab?: DetailTab;
}

/** 持久化在 app_settings 中的桌面外壳设置 */
export interface DesktopShellSettings {
  hudPosition: WindowPosition | null;
  hudOpacity: number;
  alwaysOnTop: boolean;
  muted: boolean;
  bossKey: string;
  autoLaunch: boolean;
}

/** 全局老板键注册状态 */
export interface BossKeyStatus {
  accelerator: string;
  registered: boolean;
  conflictMessage: string | null;
}

/** 桌面外壳运行态（同步给 HUD 与详情浮层） */
export interface DesktopShellState {
  settings: DesktopShellSettings;
  bossKeyStatus: BossKeyStatus;
  hudVisible: boolean;
  detailVisible: boolean;
  activeDetailSymbol: string;
  activeDetailTab: DetailTab;
  /** 每次主进程主动打开/导航详情浮层时递增，避免普通设置同步覆盖用户当前页签 */
  detailFocusSeq: number;
  isDev: boolean;
}

/** 30 交易日滚动清理执行结果 */
export interface PruneResult {
  pruned: boolean;
  keepDays: number;
  openTradingDaysCount: number;
  cutoffDate: string | null;
  deleted: {
    intradayBars: number;
    auctionSnapshots: number;
    alertEvents: number;
  };
}

/** 数据库留存统计 */
export interface DatabaseRetentionStats {
  tradingDaysCount: number;
  intradayBarsCount: number;
  auctionSnapshotsCount: number;
  watchlistCount: number;
  alertEventsCount: number;
  distinctBarDatesCount: number;
}

/** Phase 1 最小启动状态（供空窗体验证主进程/预加载桥接） */
export interface BootstrapState {
  appVersion: string;
  electronVersion: string;
  nodeVersion: string;
  dbReady: boolean;
  retention: DatabaseRetentionStats;
  secretStatus: SecretStatus;
}
