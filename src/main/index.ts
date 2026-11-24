import path from 'node:path';
import { app, BrowserWindow, ipcMain, safeStorage } from 'electron';
import { getShanghaiParts } from '../core/tradingClock';
import {
  DATABASE_FILENAME,
  DEFAULT_RETENTION_TRADING_DAYS,
  ENCRYPTED_KEY_FILENAME,
} from '../shared/constants';
import { IPC_CHANNELS } from '../shared/ipc';
import type { AlertEventInput, BootstrapState, MarketDashboardState } from '../shared/types';
import {
  EastmoneyProvider,
  HithinkProvider,
  SinaProvider,
  TencentProvider,
} from './providers';
import { PollingScheduler } from './scheduler';
import { AppDatabase } from './storage/database';
import { SecretStore } from './storage/secretStore';

let mainWindow: BrowserWindow | null = null;
let database: AppDatabase | null = null;
let secretStore: SecretStore | null = null;
let scheduler: PollingScheduler | null = null;

function broadcastMarketState(state: MarketDashboardState): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.MARKET_STATE_UPDATED, state);
  }
}

function handleAlertTriggered(event: AlertEventInput): void {
  database?.insertAlertEvent(event);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.ALERT_TRIGGERED, event);
  }
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 420,
    height: 300,
    minWidth: 360,
    minHeight: 240,
    show: false,
    title: 'A 股实时能量看板',
    backgroundColor: '#0e1117',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once('ready-to-show', () => {
    win.show();
    if (!app.isPackaged) {
      const smokeExitMs = Number(process.env.A_SHARE_SMOKE_EXIT_MS || '0');
      if (smokeExitMs > 0) {
        setTimeout(() => {
          app.quit();
        }, smokeExitMs);
      }
    }
  });

  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = null;
    }
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  return win;
}

function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.APP_GET_BOOTSTRAP_STATE, (): BootstrapState => {
    if (!database || !secretStore) {
      throw new Error('Core storage services are not initialized.');
    }
    return {
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron,
      nodeVersion: process.versions.node,
      dbReady: true,
      retention: database.getRetentionStats(),
      secretStatus: secretStore.getStatus(),
    };
  });

  ipcMain.handle(IPC_CHANNELS.SECRET_GET_STATUS, () => {
    if (!secretStore) {
      throw new Error('SecretStore is not initialized.');
    }
    return secretStore.getStatus();
  });

  ipcMain.handle(IPC_CHANNELS.MARKET_GET_STATE, () => {
    return scheduler?.getLatestState() ?? null;
  });

  ipcMain.handle(IPC_CHANNELS.MARKET_REFRESH_NOW, async () => {
    if (!scheduler) return null;
    return scheduler.refreshNow();
  });

  ipcMain.handle(
    IPC_CHANNELS.TICKER_SEARCH,
    async (_event, keyword: string, limit?: number) => {
      if (!scheduler) return [];
      return scheduler.searchTickers(keyword, limit);
    }
  );
}

function initServices(): void {
  const userDataDir = app.getPath('userData');
  const dbPath = path.join(userDataDir, DATABASE_FILENAME);
  const encryptedKeyPath = path.join(userDataDir, ENCRYPTED_KEY_FILENAME);

  database = new AppDatabase(dbPath);
  const todayShanghai = getShanghaiParts(Date.now()).dateStr;
  database.pruneOlderThanTradingDays(DEFAULT_RETENTION_TRADING_DAYS, todayShanghai);

  secretStore = new SecretStore({
    encryptedFilePath: encryptedKeyPath,
    safeStorage,
  });

  const tencentProvider = new TencentProvider();
  const sinaProvider = new SinaProvider();
  const eastmoneyProvider = new EastmoneyProvider();
  const hithinkProvider = new HithinkProvider({ secretStore });

  scheduler = new PollingScheduler({
    database,
    primarySnapshotProvider: tencentProvider,
    secondarySnapshotProvider: sinaProvider,
    hithinkProvider,
    primaryIntradayProvider: tencentProvider,
    secondaryIntradayProvider: eastmoneyProvider,
    onStateUpdate: broadcastMarketState,
    onAlertTriggered: handleAlertTriggered,
  });
}

app.whenReady().then(() => {
  initServices();
  registerIpcHandlers();
  mainWindow = createMainWindow();
  void scheduler?.start().catch((err: unknown) => {
    console.error(
      '[main] PollingScheduler start failed:',
      err instanceof Error ? err.message : String(err)
    );
  });

  app.on('activate', () => {
    if (!mainWindow && BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
    } else {
      mainWindow?.focus();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  scheduler?.stop();
  scheduler = null;
  database?.close();
  database = null;
  mainWindow = null;
});
