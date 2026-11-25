import type {
  AlertDirection,
  AlertDispatchPayload,
  AlertEventRow,
  BootstrapState,
  BossKeyStatus,
  DesktopShellState,
  MarketDashboardState,
  OpenDetailOptions,
  SecretStatus,
  TickerSearchResult,
} from './types';

/** 主进程与渲染进程共享 IPC 通道定义 */
export const IPC_CHANNELS = {
  APP_GET_BOOTSTRAP_STATE: 'app:get-bootstrap-state',
  SECRET_GET_STATUS: 'secret:get-status',
  MARKET_GET_STATE: 'market:get-state',
  MARKET_REFRESH_NOW: 'market:refresh-now',
  MARKET_STATE_UPDATED: 'market:state-updated',
  ALERT_TRIGGERED: 'alert:triggered',
  ALERT_GET_RECENT: 'alert:get-recent',
  ALERT_SIMULATE: 'alert:simulate',
  TICKER_SEARCH: 'ticker:search',
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
} as const;

/** 通过 contextBridge 暴露给渲染进程的严格类型化 API */
export interface PreloadApi {
  getBootstrapState(): Promise<BootstrapState>;
  getSecretStatus(): Promise<SecretStatus>;
  getMarketState(): Promise<MarketDashboardState | null>;
  refreshMarketNow(): Promise<MarketDashboardState | null>;
  searchTickers(keyword: string, limit?: number): Promise<TickerSearchResult[]>;
  getShellState(): Promise<DesktopShellState>;
  openDetail(options?: OpenDetailOptions): Promise<DesktopShellState>;
  hideDetail(): Promise<DesktopShellState>;
  hideHud(): Promise<DesktopShellState>;
  setHudOpacity(opacity: number): Promise<DesktopShellState>;
  setAlwaysOnTop(alwaysOnTop: boolean): Promise<DesktopShellState>;
  setMuted(muted: boolean): Promise<DesktopShellState>;
  setBossKey(accelerator: string): Promise<BossKeyStatus>;
  setAutoLaunch(enabled: boolean): Promise<DesktopShellState>;
  getRecentAlerts(tradeDate?: string, limit?: number): Promise<AlertEventRow[]>;
  simulateAlert(direction: AlertDirection, symbol?: string): Promise<AlertDispatchPayload>;
  onMarketStateUpdated(listener: (state: MarketDashboardState) => void): () => void;
  onAlertTriggered(listener: (event: AlertDispatchPayload) => void): () => void;
  onShellStateUpdated(listener: (state: DesktopShellState) => void): () => void;
}
