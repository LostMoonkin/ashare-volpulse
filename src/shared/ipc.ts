import type {
  AlertDirection,
  AlertDispatchPayload,
  AlertEventRow,
  BootstrapState,
  BossKeyStatus,
  DatabaseRetentionStats,
  DesktopShellState,
  HudMode,
  MarketDashboardState,
  MonitorConfig,
  OpenDetailOptions,
  ProviderHealthStatus,
  SecretStatus,
  TickerSearchResult,
  WatchlistAddInput,
  WatchlistItemRow,
  WatchlistUpdateInput,
} from './types';

/** 主进程与渲染进程共享 IPC 通道定义 */
export const IPC_CHANNELS = {
  APP_GET_BOOTSTRAP_STATE: 'app:get-bootstrap-state',
  SECRET_GET_STATUS: 'secret:get-status',
  SECRET_SAVE_KEY: 'secret:save-key',
  SECRET_CLEAR_KEY: 'secret:clear-key',
  SECRET_TEST_CONNECTION: 'secret:test-connection',
  DB_GET_RETENTION_STATS: 'db:get-retention-stats',
  MARKET_GET_STATE: 'market:get-state',
  MARKET_REFRESH_NOW: 'market:refresh-now',
  MARKET_STATE_UPDATED: 'market:state-updated',
  ALERT_TRIGGERED: 'alert:triggered',
  ALERT_GET_RECENT: 'alert:get-recent',
  ALERT_SIMULATE: 'alert:simulate',
  TICKER_SEARCH: 'ticker:search',
  MONITOR_GET_CONFIG: 'monitor:get-config',
  MONITOR_UPDATE_CONFIG: 'monitor:update-config',
  MONITOR_CONFIG_UPDATED: 'monitor:config-updated',
  WATCHLIST_GET_ALL: 'watchlist:get-all',
  WATCHLIST_ADD: 'watchlist:add',
  WATCHLIST_REMOVE: 'watchlist:remove',
  WATCHLIST_REORDER: 'watchlist:reorder',
  WATCHLIST_UPDATE: 'watchlist:update',
  SHELL_GET_STATE: 'shell:get-state',
  SHELL_STATE_UPDATED: 'shell:state-updated',
  SHELL_OPEN_DETAIL: 'shell:open-detail',
  SHELL_HIDE_DETAIL: 'shell:hide-detail',
  SHELL_HIDE_HUD: 'shell:hide-hud',
  SHELL_SET_OPACITY: 'shell:set-opacity',
  SHELL_SET_ALWAYS_ON_TOP: 'shell:set-always-on-top',
  SHELL_SET_MUTED: 'shell:set-muted',
  SHELL_SET_BOSS_KEY: 'shell:set-boss-key',
  SHELL_SET_AUTO_LAUNCH: 'shell:set-auto-launch',
  SHELL_SET_HUD_MODE: 'shell:set-hud-mode',
  SHELL_SET_DETAIL_MODAL_OPEN: 'shell:set-detail-modal-open',
} as const;

/** 通过 contextBridge 暴露给渲染进程的严格类型化 API */
export interface PreloadApi {
  getBootstrapState(): Promise<BootstrapState>;
  getSecretStatus(): Promise<SecretStatus>;
  saveSecretApiKey(apiKey: string): Promise<SecretStatus>;
  clearSecretApiKey(): Promise<SecretStatus>;
  testHithinkConnection(): Promise<ProviderHealthStatus>;
  getDatabaseRetentionStats(): Promise<DatabaseRetentionStats>;
  getMarketState(): Promise<MarketDashboardState | null>;
  refreshMarketNow(): Promise<MarketDashboardState | null>;
  searchTickers(keyword: string, limit?: number): Promise<TickerSearchResult[]>;
  getMonitorConfig(): Promise<MonitorConfig>;
  updateMonitorConfig(patch: Partial<MonitorConfig>): Promise<MonitorConfig>;
  getWatchlist(): Promise<WatchlistItemRow[]>;
  addWatchlistItem(input: WatchlistAddInput): Promise<WatchlistItemRow[]>;
  removeWatchlistItem(symbol: string): Promise<WatchlistItemRow[]>;
  reorderWatchlist(symbols: string[]): Promise<WatchlistItemRow[]>;
  updateWatchlistItem(input: WatchlistUpdateInput): Promise<WatchlistItemRow[]>;
  getShellState(): Promise<DesktopShellState>;
  openDetail(options?: OpenDetailOptions): Promise<DesktopShellState>;
  hideDetail(): Promise<DesktopShellState>;
  hideHud(): Promise<DesktopShellState>;
  setHudOpacity(opacity: number): Promise<DesktopShellState>;
  setAlwaysOnTop(alwaysOnTop: boolean): Promise<DesktopShellState>;
  setMuted(muted: boolean): Promise<DesktopShellState>;
  setBossKey(accelerator: string): Promise<BossKeyStatus>;
  setAutoLaunch(enabled: boolean): Promise<DesktopShellState>;
  setHudMode(mode: HudMode): Promise<DesktopShellState>;
  setDetailModalOpen(open: boolean): Promise<void>;
  getRecentAlerts(tradeDate?: string, limit?: number): Promise<AlertEventRow[]>;
  simulateAlert(direction: AlertDirection, symbol?: string): Promise<AlertDispatchPayload>;
  onMarketStateUpdated(listener: (state: MarketDashboardState) => void): () => void;
  onAlertTriggered(listener: (event: AlertDispatchPayload) => void): () => void;
  onShellStateUpdated(listener: (state: DesktopShellState) => void): () => void;
  onMonitorConfigUpdated(listener: (config: MonitorConfig) => void): () => void;
}
