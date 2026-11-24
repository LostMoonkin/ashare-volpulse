import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS, type PreloadApi } from '../shared/ipc';
import type { AlertEventInput, MarketDashboardState } from '../shared/types';

const api: PreloadApi = {
  getBootstrapState: () => ipcRenderer.invoke(IPC_CHANNELS.APP_GET_BOOTSTRAP_STATE),
  getSecretStatus: () => ipcRenderer.invoke(IPC_CHANNELS.SECRET_GET_STATUS),
  getMarketState: () => ipcRenderer.invoke(IPC_CHANNELS.MARKET_GET_STATE),
  refreshMarketNow: () => ipcRenderer.invoke(IPC_CHANNELS.MARKET_REFRESH_NOW),
  searchTickers: (keyword: string, limit?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.TICKER_SEARCH, keyword, limit),
  onMarketStateUpdated: (listener: (state: MarketDashboardState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: MarketDashboardState) => {
      listener(state);
    };
    ipcRenderer.on(IPC_CHANNELS.MARKET_STATE_UPDATED, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.MARKET_STATE_UPDATED, handler);
    };
  },
  onAlertTriggered: (listener: (event: AlertEventInput) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, alertEvent: AlertEventInput) => {
      listener(alertEvent);
    };
    ipcRenderer.on(IPC_CHANNELS.ALERT_TRIGGERED, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.ALERT_TRIGGERED, handler);
    };
  },
};

contextBridge.exposeInMainWorld('api', api);
