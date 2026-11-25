import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS, type PreloadApi } from '../shared/ipc';
import type {
  AlertDirection,
  AlertDispatchPayload,
  DesktopShellState,
  MarketDashboardState,
  OpenDetailOptions,
} from '../shared/types';

const api: PreloadApi = {
  getBootstrapState: () => ipcRenderer.invoke(IPC_CHANNELS.APP_GET_BOOTSTRAP_STATE),
  getSecretStatus: () => ipcRenderer.invoke(IPC_CHANNELS.SECRET_GET_STATUS),
  getMarketState: () => ipcRenderer.invoke(IPC_CHANNELS.MARKET_GET_STATE),
  refreshMarketNow: () => ipcRenderer.invoke(IPC_CHANNELS.MARKET_REFRESH_NOW),
  searchTickers: (keyword: string, limit?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.TICKER_SEARCH, keyword, limit),

  getShellState: () => ipcRenderer.invoke(IPC_CHANNELS.SHELL_GET_STATE),
  openDetail: (options?: OpenDetailOptions) =>
    ipcRenderer.invoke(IPC_CHANNELS.SHELL_OPEN_DETAIL, options),
  hideDetail: () => ipcRenderer.invoke(IPC_CHANNELS.SHELL_HIDE_DETAIL),
  hideHud: () => ipcRenderer.invoke(IPC_CHANNELS.SHELL_HIDE_HUD),
  setHudOpacity: (opacity: number) => ipcRenderer.invoke(IPC_CHANNELS.SHELL_SET_OPACITY, opacity),
  setAlwaysOnTop: (alwaysOnTop: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.SHELL_SET_ALWAYS_ON_TOP, alwaysOnTop),
  setMuted: (muted: boolean) => ipcRenderer.invoke(IPC_CHANNELS.SHELL_SET_MUTED, muted),
  setBossKey: (accelerator: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SHELL_SET_BOSS_KEY, accelerator),
  setAutoLaunch: (enabled: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.SHELL_SET_AUTO_LAUNCH, enabled),

  getRecentAlerts: (tradeDate?: string, limit?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.ALERT_GET_RECENT, tradeDate, limit),
  simulateAlert: (direction: AlertDirection, symbol?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.ALERT_SIMULATE, direction, symbol),

  onMarketStateUpdated: (listener: (state: MarketDashboardState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: MarketDashboardState) => {
      listener(state);
    };
    ipcRenderer.on(IPC_CHANNELS.MARKET_STATE_UPDATED, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.MARKET_STATE_UPDATED, handler);
    };
  },

  onAlertTriggered: (listener: (event: AlertDispatchPayload) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, alertEvent: AlertDispatchPayload) => {
      listener(alertEvent);
    };
    ipcRenderer.on(IPC_CHANNELS.ALERT_TRIGGERED, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.ALERT_TRIGGERED, handler);
    };
  },

  onShellStateUpdated: (listener: (state: DesktopShellState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: DesktopShellState) => {
      listener(state);
    };
    ipcRenderer.on(IPC_CHANNELS.SHELL_STATE_UPDATED, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.SHELL_STATE_UPDATED, handler);
    };
  },
};

contextBridge.exposeInMainWorld('api', api);
