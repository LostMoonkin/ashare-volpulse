import type {
  AlertEventInput,
  BootstrapState,
  MarketDashboardState,
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
  TICKER_SEARCH: 'ticker:search',
} as const;

/** 通过 contextBridge 暴露给渲染进程的严格类型化只读 API */
export interface PreloadApi {
  getBootstrapState(): Promise<BootstrapState>;
  getSecretStatus(): Promise<SecretStatus>;
  getMarketState(): Promise<MarketDashboardState | null>;
  refreshMarketNow(): Promise<MarketDashboardState | null>;
  searchTickers(keyword: string, limit?: number): Promise<TickerSearchResult[]>;
  onMarketStateUpdated(listener: (state: MarketDashboardState) => void): () => void;
  onAlertTriggered(listener: (event: AlertEventInput) => void): () => void;
}
