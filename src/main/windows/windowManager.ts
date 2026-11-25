import path from 'node:path';
import { app, BrowserWindow, screen } from 'electron';
import {
  DETAIL_DEFAULT_HEIGHT,
  DETAIL_DEFAULT_WIDTH,
  DETAIL_MIN_HEIGHT,
  DETAIL_MIN_WIDTH,
  HUD_DEFAULT_HEIGHT,
  HUD_DEFAULT_WIDTH,
  MARKET_TOTAL_SYMBOL,
} from '../../shared/constants';
import type {
  DesktopShellSettings,
  DetailTab,
  OpenDetailOptions,
  WindowPosition,
} from '../../shared/types';
import {
  clampHudOpacity,
  computeDetailOverlayBounds,
  resolveHudBounds,
  type Rect,
} from './windowGeometry';

export interface WindowVisibilitySnapshot {
  hudVisible: boolean;
  detailVisible: boolean;
}

/**
 * 老板键一键显隐状态机（纯逻辑，便于独立单测）：
 * - 隐藏前记忆 HUD 与详情浮层各自的可见状态
 * - 再次触发时按隐藏前状态精确恢复（若两者原均不可见则至少恢复 HUD）
 */
export class BossVisibilityController {
  private savedBeforeHide: WindowVisibilitySnapshot | null = null;

  computeNextVisibility(current: WindowVisibilitySnapshot): {
    action: 'hide' | 'restore';
    target: WindowVisibilitySnapshot;
  } {
    if (current.hudVisible || current.detailVisible) {
      this.savedBeforeHide = {
        hudVisible: current.hudVisible,
        detailVisible: current.detailVisible,
      };
      return {
        action: 'hide',
        target: { hudVisible: false, detailVisible: false },
      };
    }

    const restoreTarget: WindowVisibilitySnapshot = this.savedBeforeHide
      ? {
          hudVisible: this.savedBeforeHide.hudVisible || !this.savedBeforeHide.detailVisible,
          detailVisible: this.savedBeforeHide.detailVisible,
        }
      : { hudVisible: true, detailVisible: false };

    this.savedBeforeHide = null;
    return {
      action: 'restore',
      target: restoreTarget,
    };
  }

  clearSnapshot(): void {
    this.savedBeforeHide = null;
  }
}

export interface WindowManagerOptions {
  preloadPath: string;
  rendererHtmlPath: string;
  rendererDevUrl?: string;
  initialSettings: DesktopShellSettings;
  onHudPositionCommitted: (position: WindowPosition) => void;
  onStateChanged: () => void;
  onWindowReady?: (win: BrowserWindow, view: 'hud' | 'detail') => void;
}

/**
 * 双态桌面窗口管理器（紧凑 HUD 悬浮窗 + 详情浮层窗口）：
 * - HUD：无边框、透明圆角、置顶、不占任务栏、记忆坐标与 30%–100% 透明度
 * - Detail：贴近 HUD 弹出（空间不足则屏幕居中）、失焦不销毁、Esc 或点击收起隐藏
 * - 关闭按钮仅隐藏至托盘，只有明确 quit 时才允许真正销毁窗口
 */
export class WindowManager {
  private readonly options: WindowManagerOptions;
  private readonly bossVisibility = new BossVisibilityController();
  private hudWindow: BrowserWindow | null = null;
  private detailWindow: BrowserWindow | null = null;
  private settings: DesktopShellSettings;
  private activeDetailSymbol = MARKET_TOTAL_SYMBOL;
  private activeDetailTab: DetailTab = 'chart';
  private detailFocusSeq = 0;
  private isQuitting = false;
  private moveSaveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: WindowManagerOptions) {
    this.options = options;
    this.settings = { ...options.initialSettings };
  }

  prepareForQuit(): void {
    this.isQuitting = true;
    this.flushPendingMoveSave();
  }

  isHudVisible(): boolean {
    return Boolean(this.hudWindow && !this.hudWindow.isDestroyed() && this.hudWindow.isVisible());
  }

  isDetailVisible(): boolean {
    return Boolean(
      this.detailWindow && !this.detailWindow.isDestroyed() && this.detailWindow.isVisible()
    );
  }

  getActiveDetailSymbol(): string {
    return this.activeDetailSymbol;
  }

  getActiveDetailTab(): DetailTab {
    return this.activeDetailTab;
  }

  getDetailFocusSeq(): number {
    return this.detailFocusSeq;
  }

  private getDisplayMetrics(): { workAreas: Rect[]; primaryWorkArea: Rect } {
    const displays = screen.getAllDisplays();
    const primary = screen.getPrimaryDisplay();
    return {
      workAreas: displays.map((d) => d.workArea),
      primaryWorkArea: primary.workArea,
    };
  }

  private loadView(win: BrowserWindow, view: 'hud' | 'detail'): void {
    if (this.options.rendererDevUrl) {
      const url = new URL(this.options.rendererDevUrl);
      url.searchParams.set('view', view);
      void win.loadURL(url.toString());
    } else {
      void win.loadFile(this.options.rendererHtmlPath, { query: { view } });
    }
  }

  createHudWindow(): BrowserWindow {
    if (this.hudWindow && !this.hudWindow.isDestroyed()) {
      return this.hudWindow;
    }

    const { workAreas, primaryWorkArea } = this.getDisplayMetrics();
    const bounds = resolveHudBounds(
      this.settings.hudPosition,
      { width: HUD_DEFAULT_WIDTH, height: HUD_DEFAULT_HEIGHT },
      workAreas,
      primaryWorkArea
    );

    const win = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      minWidth: HUD_DEFAULT_WIDTH,
      minHeight: HUD_DEFAULT_HEIGHT,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      alwaysOnTop: this.settings.alwaysOnTop,
      skipTaskbar: true,
      show: false,
      title: 'A 股实时能量看板 HUD',
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    win.setOpacity(clampHudOpacity(this.settings.hudOpacity));
    if (this.settings.alwaysOnTop) {
      win.setAlwaysOnTop(true, 'floating');
    }

    win.once('ready-to-show', () => {
      if (win.isDestroyed()) return;
      win.setOpacity(clampHudOpacity(this.settings.hudOpacity));
      if (this.settings.alwaysOnTop) {
        win.setAlwaysOnTop(true, 'floating');
      }
      win.show();
      this.options.onStateChanged();

      if (!app.isPackaged) {
        const smokeExitMs = Number(process.env.A_SHARE_SMOKE_EXIT_MS || '0');
        if (smokeExitMs > 0) {
          setTimeout(() => {
            this.prepareForQuit();
            app.quit();
          }, smokeExitMs);
        }
      }
    });

    win.webContents.on('did-finish-load', () => {
      this.options.onWindowReady?.(win, 'hud');
    });

    win.on('moved', () => {
      if (win.isDestroyed()) return;
      this.scheduleMoveSave();
    });

    win.on('show', () => this.options.onStateChanged());
    win.on('hide', () => this.options.onStateChanged());

    win.on('close', (event) => {
      if (!this.isQuitting) {
        event.preventDefault();
        win.hide();
        this.options.onStateChanged();
      }
    });

    win.on('closed', () => {
      if (this.hudWindow === win) {
        this.hudWindow = null;
      }
    });

    this.hudWindow = win;
    this.loadView(win, 'hud');
    return win;
  }

  ensureDetailWindow(): BrowserWindow {
    if (this.detailWindow && !this.detailWindow.isDestroyed()) {
      return this.detailWindow;
    }

    const { workAreas, primaryWorkArea } = this.getDisplayMetrics();
    const hudBounds =
      this.hudWindow && !this.hudWindow.isDestroyed() ? this.hudWindow.getBounds() : null;
    const bounds = computeDetailOverlayBounds(
      hudBounds,
      { width: DETAIL_DEFAULT_WIDTH, height: DETAIL_DEFAULT_HEIGHT },
      workAreas,
      primaryWorkArea
    );

    const win = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      minWidth: DETAIL_MIN_WIDTH,
      minHeight: DETAIL_MIN_HEIGHT,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: true,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      alwaysOnTop: this.settings.alwaysOnTop,
      skipTaskbar: true,
      show: false,
      title: 'A 股实时能量看板 - 详情浮层',
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    if (this.settings.alwaysOnTop) {
      win.setAlwaysOnTop(true, 'floating');
    }

    // 失焦不销毁、不自动隐藏；仅按 Esc 或点击收起按钮隐藏
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') {
        event.preventDefault();
        this.hideDetail();
      }
    });

    win.webContents.on('did-finish-load', () => {
      this.options.onWindowReady?.(win, 'detail');
    });

    win.on('show', () => this.options.onStateChanged());
    win.on('hide', () => this.options.onStateChanged());

    win.on('close', (event) => {
      if (!this.isQuitting) {
        event.preventDefault();
        win.hide();
        this.options.onStateChanged();
      }
    });

    win.on('closed', () => {
      if (this.detailWindow === win) {
        this.detailWindow = null;
      }
    });

    this.detailWindow = win;
    this.loadView(win, 'detail');
    return win;
  }

  showHud(): void {
    const win = this.createHudWindow();
    this.bossVisibility.clearSnapshot();
    const { workAreas, primaryWorkArea } = this.getDisplayMetrics();
    const current = win.getBounds();
    const safeBounds = resolveHudBounds(
      { x: current.x, y: current.y },
      { width: current.width, height: current.height },
      workAreas,
      primaryWorkArea
    );
    if (safeBounds.x !== current.x || safeBounds.y !== current.y) {
      win.setPosition(safeBounds.x, safeBounds.y);
    }
    if (this.settings.alwaysOnTop) {
      win.setAlwaysOnTop(true, 'floating');
    }
    win.setOpacity(clampHudOpacity(this.settings.hudOpacity));
    win.show();
    win.focus();
    this.options.onStateChanged();
  }

  hideHud(): void {
    if (this.hudWindow && !this.hudWindow.isDestroyed()) {
      this.hudWindow.hide();
      this.options.onStateChanged();
    }
  }

  toggleHud(): void {
    if (this.isHudVisible()) {
      this.hideHud();
    } else {
      this.showHud();
    }
  }

  openDetail(options?: OpenDetailOptions): void {
    if (options?.symbol && options.symbol.trim().length > 0) {
      this.activeDetailSymbol = options.symbol.trim();
    }
    if (options?.tab) {
      this.activeDetailTab = options.tab;
    }
    if (options?.symbol || options?.tab) {
      this.detailFocusSeq += 1;
    }

    const win = this.ensureDetailWindow();
    const wasVisible = win.isVisible();
    this.bossVisibility.clearSnapshot();

    if (!wasVisible) {
      const { workAreas, primaryWorkArea } = this.getDisplayMetrics();
      const hudBounds =
        this.hudWindow && !this.hudWindow.isDestroyed() ? this.hudWindow.getBounds() : null;
      const currentSize = win.getBounds();
      const nextBounds = computeDetailOverlayBounds(
        hudBounds,
        {
          width: currentSize.width || DETAIL_DEFAULT_WIDTH,
          height: currentSize.height || DETAIL_DEFAULT_HEIGHT,
        },
        workAreas,
        primaryWorkArea
      );
      win.setBounds(nextBounds);
    }

    if (this.settings.alwaysOnTop) {
      win.setAlwaysOnTop(true, 'floating');
    }
    win.show();
    win.focus();
    this.options.onStateChanged();
  }

  hideDetail(): void {
    if (this.detailWindow && !this.detailWindow.isDestroyed() && this.detailWindow.isVisible()) {
      this.detailWindow.hide();
      this.options.onStateChanged();
    }
  }

  toggleDetail(): void {
    if (this.isDetailVisible()) {
      this.hideDetail();
    } else {
      this.openDetail();
    }
  }

  /** 老板键触发：隐藏所有窗口并记忆状态；再次触发时恢复到隐藏前状态 */
  toggleBossKeyVisibility(): { action: 'hide' | 'restore'; target: WindowVisibilitySnapshot } {
    const decision = this.bossVisibility.computeNextVisibility({
      hudVisible: this.isHudVisible(),
      detailVisible: this.isDetailVisible(),
    });

    if (decision.action === 'hide') {
      if (this.hudWindow && !this.hudWindow.isDestroyed()) {
        this.hudWindow.hide();
      }
      if (this.detailWindow && !this.detailWindow.isDestroyed()) {
        this.detailWindow.hide();
      }
    } else {
      if (decision.target.hudVisible) {
        const hud = this.createHudWindow();
        if (this.settings.alwaysOnTop) {
          hud.setAlwaysOnTop(true, 'floating');
        }
        hud.setOpacity(clampHudOpacity(this.settings.hudOpacity));
        hud.show();
      }
      if (decision.target.detailVisible) {
        const detail = this.ensureDetailWindow();
        if (this.settings.alwaysOnTop) {
          detail.setAlwaysOnTop(true, 'floating');
        }
        detail.show();
        detail.focus();
      }
    }

    this.options.onStateChanged();
    return decision;
  }

  applyOpacity(opacity: number): number {
    const clamped = clampHudOpacity(opacity);
    this.settings = { ...this.settings, hudOpacity: clamped };
    if (this.hudWindow && !this.hudWindow.isDestroyed()) {
      this.hudWindow.setOpacity(clamped);
    }
    return clamped;
  }

  applyAlwaysOnTop(alwaysOnTop: boolean): boolean {
    const normalized = Boolean(alwaysOnTop);
    this.settings = { ...this.settings, alwaysOnTop: normalized };

    for (const win of [this.hudWindow, this.detailWindow]) {
      if (win && !win.isDestroyed()) {
        if (normalized) {
          win.setAlwaysOnTop(true, 'floating');
        } else {
          win.setAlwaysOnTop(false);
        }
      }
    }
    return normalized;
  }

  broadcast(channel: string, payload: unknown): void {
    for (const win of [this.hudWindow, this.detailWindow]) {
      if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send(channel, payload);
      }
    }
  }

  private scheduleMoveSave(): void {
    if (this.moveSaveTimer) {
      clearTimeout(this.moveSaveTimer);
    }
    this.moveSaveTimer = setTimeout(() => {
      this.moveSaveTimer = null;
      this.commitCurrentHudPosition();
    }, 200);
  }

  private flushPendingMoveSave(): void {
    if (this.moveSaveTimer) {
      clearTimeout(this.moveSaveTimer);
      this.moveSaveTimer = null;
      this.commitCurrentHudPosition();
    }
  }

  private commitCurrentHudPosition(): void {
    if (!this.hudWindow || this.hudWindow.isDestroyed()) return;
    const [x, y] = this.hudWindow.getPosition();
    const pos: WindowPosition = { x, y };
    this.settings = { ...this.settings, hudPosition: pos };
    this.options.onHudPositionCommitted(pos);
  }

  destroyAll(): void {
    this.prepareForQuit();
    if (this.detailWindow && !this.detailWindow.isDestroyed()) {
      this.detailWindow.destroy();
    }
    if (this.hudWindow && !this.hudWindow.isDestroyed()) {
      this.hudWindow.destroy();
    }
    this.detailWindow = null;
    this.hudWindow = null;
  }
}

export function resolvePreloadPath(mainDirname: string): string {
  return path.join(mainDirname, '../preload/index.js');
}

export function resolveRendererHtmlPath(mainDirname: string): string {
  return path.join(mainDirname, '../renderer/index.html');
}
