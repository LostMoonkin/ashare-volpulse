import path from 'node:path';
import { app, BrowserWindow, ipcMain, safeStorage } from 'electron';
import { getShanghaiParts } from '../core/tradingClock';
import {
  DATABASE_FILENAME,
  DEFAULT_RETENTION_TRADING_DAYS,
  ENCRYPTED_KEY_FILENAME,
} from '../shared/constants';
import { IPC_CHANNELS } from '../shared/ipc';
import type { BootstrapState } from '../shared/types';
import { AppDatabase } from './storage/database';
import { SecretStore } from './storage/secretStore';

let mainWindow: BrowserWindow | null = null;
let database: AppDatabase | null = null;
let secretStore: SecretStore | null = null;

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
}

app.whenReady().then(() => {
  initServices();
  registerIpcHandlers();
  mainWindow = createMainWindow();

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
  database?.close();
  database = null;
  mainWindow = null;
});
