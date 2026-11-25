import path from 'node:path';
import { app, ipcMain, safeStorage } from 'electron';
import { getShanghaiParts } from '../core/tradingClock';
import {
  APP_USER_MODEL_ID,
  DATABASE_FILENAME,
  DEFAULT_RETENTION_TRADING_DAYS,
  ENCRYPTED_KEY_FILENAME,
  MARKET_TOTAL_SYMBOL,
} from '../shared/constants';
import { IPC_CHANNELS } from '../shared/ipc';
import type {
  AlertDirection,
  AlertEventInput,
  BootstrapState,
  DesktopShellSettings,
  DesktopShellState,
  MarketDashboardState,
  OpenDetailOptions,
} from '../shared/types';
import { AlertDispatcher } from './alerts';
import {
  EastmoneyProvider,
  HithinkProvider,
  SinaProvider,
  TencentProvider,
} from './providers';
import { PollingScheduler } from './scheduler';
import { AppDatabase } from './storage/database';
import { SecretStore } from './storage/secretStore';
import { BossKeyManager, TrayManager } from './tray';
import {
  ShellSettingsStore,
  WindowManager,
  resolvePreloadPath,
  resolveRendererHtmlPath,
} from './windows';

if (process.platform === 'win32') {
  app.setAppUserModelId(APP_USER_MODEL_ID);
}

const isDevMode = !app.isPackaged;
const singleInstanceLock = app.requestSingleInstanceLock();

let database: AppDatabase | null = null;
let secretStore: SecretStore | null = null;
let settingsStore: ShellSettingsStore | null = null;
let shellSettings: DesktopShellSettings | null = null;
let windowManager: WindowManager | null = null;
let trayManager: TrayManager | null = null;
let bossKeyManager: BossKeyManager | null = null;
let alertDispatcher: AlertDispatcher | null = null;
let scheduler: PollingScheduler | null = null;

function buildShellState(): DesktopShellState {
  if (!shellSettings || !windowManager || !bossKeyManager) {
    throw new Error('Desktop shell services are not initialized.');
  }
  return {
    settings: { ...shellSettings },
    bossKeyStatus: bossKeyManager.getStatus(),
    hudVisible: windowManager.isHudVisible(),
    detailVisible: windowManager.isDetailVisible(),
    activeDetailSymbol: windowManager.getActiveDetailSymbol(),
    activeDetailTab: windowManager.getActiveDetailTab(),
    detailFocusSeq: windowManager.getDetailFocusSeq(),
    isDev: isDevMode,
  };
}

function syncShellState(): DesktopShellState {
  const state = buildShellState();
  trayManager?.updateShellState(state);
  windowManager?.broadcast(IPC_CHANNELS.SHELL_STATE_UPDATED, state);
  return state;
}

function broadcastMarketState(state: MarketDashboardState): void {
  trayManager?.updateMarketState(state);
  windowManager?.broadcast(IPC_CHANNELS.MARKET_STATE_UPDATED, state);
}

function handleAlertTriggered(event: AlertEventInput): void {
  alertDispatcher?.dispatch(event);
}

function applyAutoLaunchSetting(enabled: boolean): void {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return;
  try {
    if (app.isPackaged) {
      app.setLoginItemSettings({ openAtLogin: enabled });
    } else if (process.platform === 'win32') {
      const appArg = process.argv[1] ? path.resolve(process.argv[1]) : process.cwd();
      app.setLoginItemSettings({
        openAtLogin: enabled,
        path: process.execPath,
        args: [appArg],
      });
    }
  } catch (err: unknown) {
    console.warn(
      '[main] setLoginItemSettings failed:',
      err instanceof Error ? err.message : String(err)
    );
  }
}

function updateAlwaysOnTop(alwaysOnTop: boolean): DesktopShellState {
  if (!settingsStore || !shellSettings || !windowManager) {
    throw new Error('Desktop shell is not ready.');
  }
  const normalized = settingsStore.setAlwaysOnTop(alwaysOnTop);
  shellSettings = { ...shellSettings, alwaysOnTop: normalized };
  windowManager.applyAlwaysOnTop(normalized);
  return syncShellState();
}

function updateMuted(muted: boolean): DesktopShellState {
  if (!settingsStore || !shellSettings) {
    throw new Error('Desktop shell is not ready.');
  }
  const normalized = settingsStore.setMuted(muted);
  shellSettings = { ...shellSettings, muted: normalized };
  return syncShellState();
}

function updateHudOpacity(opacity: number): DesktopShellState {
  if (!settingsStore || !shellSettings || !windowManager) {
    throw new Error('Desktop shell is not ready.');
  }
  const clamped = settingsStore.setHudOpacity(opacity);
  shellSettings = { ...shellSettings, hudOpacity: clamped };
  windowManager.applyOpacity(clamped);
  return syncShellState();
}

function updateAutoLaunch(enabled: boolean): DesktopShellState {
  if (!settingsStore || !shellSettings) {
    throw new Error('Desktop shell is not ready.');
  }
  const normalized = settingsStore.setAutoLaunch(enabled);
  shellSettings = { ...shellSettings, autoLaunch: normalized };
  applyAutoLaunchSetting(normalized);
  return syncShellState();
}

function requestQuit(): void {
  windowManager?.prepareForQuit();
  app.quit();
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

  ipcMain.handle(IPC_CHANNELS.SHELL_GET_STATE, (): DesktopShellState => {
    return buildShellState();
  });

  ipcMain.handle(
    IPC_CHANNELS.SHELL_OPEN_DETAIL,
    (_event, options?: OpenDetailOptions): DesktopShellState => {
      windowManager?.openDetail(options);
      return buildShellState();
    }
  );

  ipcMain.handle(IPC_CHANNELS.SHELL_HIDE_DETAIL, (): DesktopShellState => {
    windowManager?.hideDetail();
    return buildShellState();
  });

  ipcMain.handle(IPC_CHANNELS.SHELL_HIDE_HUD, (): DesktopShellState => {
    windowManager?.hideHud();
    return buildShellState();
  });

  ipcMain.handle(IPC_CHANNELS.SHELL_SET_OPACITY, (_event, opacity: number): DesktopShellState => {
    return updateHudOpacity(opacity);
  });

  ipcMain.handle(
    IPC_CHANNELS.SHELL_SET_ALWAYS_ON_TOP,
    (_event, alwaysOnTop: boolean): DesktopShellState => {
      return updateAlwaysOnTop(alwaysOnTop);
    }
  );

  ipcMain.handle(IPC_CHANNELS.SHELL_SET_MUTED, (_event, muted: boolean): DesktopShellState => {
    return updateMuted(muted);
  });

  ipcMain.handle(IPC_CHANNELS.SHELL_SET_BOSS_KEY, (_event, accelerator: string) => {
    if (!bossKeyManager || !settingsStore || !shellSettings) {
      throw new Error('BossKeyManager is not initialized.');
    }
    const result = bossKeyManager.rebind(accelerator);
    if (result.success && result.committedAccelerator) {
      const saved = settingsStore.setBossKey(result.committedAccelerator);
      shellSettings = { ...shellSettings, bossKey: saved };
    }
    syncShellState();
    return result.status;
  });

  ipcMain.handle(
    IPC_CHANNELS.SHELL_SET_AUTO_LAUNCH,
    (_event, enabled: boolean): DesktopShellState => {
      return updateAutoLaunch(enabled);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.ALERT_GET_RECENT,
    (_event, tradeDate?: string, limit?: number) => {
      if (!database) return [];
      const safeLimit =
        typeof limit === 'number' && Number.isFinite(limit)
          ? Math.max(1, Math.min(500, Math.round(limit)))
          : 100;
      return database.getAlertEvents(tradeDate, safeLimit);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.ALERT_SIMULATE,
    (_event, direction: AlertDirection, symbol?: string) => {
      if (!alertDispatcher) {
        throw new Error('AlertDispatcher is not initialized.');
      }
      if (direction !== 'SURGE' && direction !== 'SHRINK') {
        throw new Error(`Invalid alert direction: ${String(direction)}`);
      }
      return alertDispatcher.dispatchSimulated(direction, {
        symbol: symbol ?? MARKET_TOTAL_SYMBOL,
      });
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

  settingsStore = new ShellSettingsStore(database);
  shellSettings = settingsStore.load();

  windowManager = new WindowManager({
    preloadPath: resolvePreloadPath(__dirname),
    rendererHtmlPath: resolveRendererHtmlPath(__dirname),
    rendererDevUrl: process.env.ELECTRON_RENDERER_URL,
    initialSettings: shellSettings,
    onHudPositionCommitted: (pos) => {
      if (!settingsStore || !shellSettings) return;
      const saved = settingsStore.setHudPosition(pos);
      shellSettings = { ...shellSettings, hudPosition: saved };
      syncShellState();
    },
    onStateChanged: () => {
      if (shellSettings && windowManager && bossKeyManager) {
        syncShellState();
      }
    },
    onWindowReady: (win) => {
      if (win.isDestroyed()) return;
      if (shellSettings && windowManager && bossKeyManager) {
        win.webContents.send(IPC_CHANNELS.SHELL_STATE_UPDATED, buildShellState());
      }
      const latestMarket = scheduler?.getLatestState();
      if (latestMarket) {
        win.webContents.send(IPC_CHANNELS.MARKET_STATE_UPDATED, latestMarket);
      }
    },
  });

  alertDispatcher = new AlertDispatcher({
    database,
    isMuted: () => Boolean(shellSettings?.muted),
    broadcastAlert: (payload) => {
      windowManager?.broadcast(IPC_CHANNELS.ALERT_TRIGGERED, payload);
    },
    onNotificationClick: (symbol) => {
      windowManager?.openDetail({ symbol, tab: 'alerts' });
    },
    allowSimulation: isDevMode,
  });

  bossKeyManager = new BossKeyManager({
    onTrigger: () => {
      windowManager?.toggleBossKeyVisibility();
    },
    onConflict: (status) => {
      alertDispatcher?.notifyBossKeyConflict(status);
    },
  });

  trayManager = new TrayManager({
    onToggleHud: () => windowManager?.toggleHud(),
    onToggleDetail: () => windowManager?.toggleDetail(),
    onToggleAlwaysOnTop: (next) => {
      updateAlwaysOnTop(next);
    },
    onToggleMuted: (next) => {
      updateMuted(next);
    },
    onToggleAutoLaunch: (next) => {
      updateAutoLaunch(next);
    },
    onRefreshNow: () => {
      void scheduler?.refreshNow();
    },
    onOpenSettings: () => {
      windowManager?.openDetail({ tab: 'settings' });
    },
    onSimulateAlert: isDevMode
      ? (direction) => {
          alertDispatcher?.dispatchSimulated(direction);
        }
      : undefined,
    onQuit: requestQuit,
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

if (!singleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    windowManager?.showHud();
  });

  app.whenReady().then(() => {
    initServices();
    registerIpcHandlers();

    if (shellSettings) {
      bossKeyManager?.registerInitial(shellSettings.bossKey);
      if (shellSettings.autoLaunch) {
        applyAutoLaunchSetting(true);
      }
    }

    windowManager?.createHudWindow();
    trayManager?.init(buildShellState(), scheduler?.getLatestState() ?? null);

    void scheduler?.start().catch((err: unknown) => {
      console.error(
        '[main] PollingScheduler start failed:',
        err instanceof Error ? err.message : String(err)
      );
    });

    app.on('activate', () => {
      windowManager?.showHud();
    });
  });

  // 关闭窗口仅隐藏至托盘，不自动退出应用；只有托盘「退出」触发真正退出
  app.on('window-all-closed', () => {
    // 刻意保持驻留系统托盘
  });

  app.on('before-quit', () => {
    windowManager?.prepareForQuit();
  });

  app.on('will-quit', () => {
    bossKeyManager?.unregister();
    bossKeyManager = null;
    trayManager?.destroy();
    trayManager = null;
    scheduler?.stop();
    scheduler = null;
    windowManager?.destroyAll();
    windowManager = null;
    database?.close();
    database = null;
  });
}
