/**
 * 前后端共享数据类型与 SQLite 持久化行契约
 */

export type AlertDirection = 'SURGE' | 'SHRINK';

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
