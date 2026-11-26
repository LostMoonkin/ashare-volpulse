import { Menu, Tray, type MenuItemConstructorOptions } from 'electron';
import type {
  AlertDirection,
  DesktopShellState,
  MarketDashboardState,
  TrayStatus,
} from '../../shared/types';
import { getTrayNativeImage, resolveTrayIconMood, type TrayIconMood } from './trayIcon';
import { formatTrayTooltip } from './trayTooltip';

export interface TrayManagerActions {
  onToggleHud: () => void;
  onToggleDetail: () => void;
  onToggleMinimalMode: (next: boolean) => void;
  onToggleAlwaysOnTop: (next: boolean) => void;
  onToggleMuted: (next: boolean) => void;
  onToggleAutoLaunch: (next: boolean) => void;
  onRefreshNow: () => void;
  onOpenSettings: () => void;
  onSimulateAlert?: (direction: AlertDirection) => void;
  onQuit: () => void;
  /** 托盘健康状态变更回调（供主进程向 HUD / 设置页同步状态） */
  onStatusChange?: (status: TrayStatus) => void;
}

export interface TrayManagerOptions {
  /** Windows 托盘未检测到有效区域时的有界自动重试退避序列（毫秒） */
  retryDelaysMs?: readonly number[];
}

const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [1500, 4000, 10000];

const TRAY_RETRYING_MESSAGE = '正在尝试重新注册系统托盘图标…';
const TRAY_UNVERIFIED_MESSAGE =
  '未检测到系统托盘图标（请检查右下角 ^ 折叠区，或重启资源管理器后点击「重试托盘」）';

function hasNonZeroTrayBounds(tray: Tray): boolean {
  if (typeof tray.getBounds !== 'function') {
    return true;
  }
  try {
    const bounds = tray.getBounds();
    return Boolean(bounds && bounds.width > 0 && bounds.height > 0);
  } catch {
    return false;
  }
}

/**
 * Windows / macOS 系统托盘管理器：
 * - 右键菜单完整覆盖显隐、详情、极简、置顶、静音、开机自启、手动刷新、设置、退出
 * - 悬停 Tooltip 实时展示两市总成交额与放/平/缩量及降级状态
 * - Windows 托盘注册失败/不可见时支持有界延迟重试、交互事件自动转正与手动重建
 */
export class TrayManager {
  private readonly actions: TrayManagerActions;
  private readonly platform: NodeJS.Platform;
  private readonly retryDelaysMs: readonly number[];
  private tray: Tray | null = null;
  private currentMood: TrayIconMood = 'flat';
  private lastShellState: DesktopShellState | null = null;
  private lastMarketState: MarketDashboardState | null = null;
  private initialized = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private nextRetryIndex = 0;
  private status: TrayStatus = {
    state: 'ready',
    available: true,
    attempts: 0,
    message: null,
  };

  constructor(
    actions: TrayManagerActions,
    platform: NodeJS.Platform = process.platform,
    options?: TrayManagerOptions
  ) {
    this.actions = actions;
    this.platform = platform;
    this.retryDelaysMs = options?.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  }

  getStatus(): TrayStatus {
    return { ...this.status };
  }

  init(initialShellState: DesktopShellState, initialMarketState: MarketDashboardState | null): void {
    if (this.initialized) return;
    this.initialized = true;
    this.lastShellState = initialShellState;
    this.lastMarketState = initialMarketState;
    this.currentMood = resolveTrayIconMood(initialMarketState);
    this.nextRetryIndex = 0;

    this.createTrayAttempt();
  }

  /**
   * 手动触发托盘重建（例如用户在重启 Windows 资源管理器后点击「重试托盘」）：
   * - 若当前托盘已被系统确认存在非零区域，直接标记就绪，不破坏现有图标
   * - 否则清理旧实例、重置重试计数并立即重建
   */
  retry(): TrayStatus {
    if (!this.initialized) {
      return this.getStatus();
    }
    if (this.tray && this.platform === 'win32' && hasNonZeroTrayBounds(this.tray)) {
      this.clearRetryTimer();
      this.setStatus({
        state: 'ready',
        available: true,
        attempts: this.status.attempts,
        message: null,
      });
      return this.getStatus();
    }

    this.clearRetryTimer();
    this.destroyTrayInstanceOnly();
    this.nextRetryIndex = 0;
    this.createTrayAttempt();
    return this.getStatus();
  }

  updateMarketState(state: MarketDashboardState | null): void {
    this.lastMarketState = state;
    if (!this.tray) return;

    const nextMood = resolveTrayIconMood(state);
    if (nextMood !== this.currentMood) {
      this.currentMood = nextMood;
      this.tray.setImage(getTrayNativeImage(nextMood));
    }
    this.tray.setToolTip(formatTrayTooltip(state));
  }

  updateShellState(state: DesktopShellState): void {
    this.lastShellState = state;
    if (!this.tray) return;
    this.rebuildContextMenu();
  }

  private createTrayAttempt(): void {
    const attempts = this.status.attempts + 1;
    this.currentMood = resolveTrayIconMood(this.lastMarketState);

    let createdTray: Tray;
    try {
      createdTray = new Tray(getTrayNativeImage(this.currentMood));
      createdTray.setToolTip(formatTrayTooltip(this.lastMarketState));
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      this.destroyTrayInstanceOnly();
      this.handleCreateFailure(attempts, `系统托盘创建失败：${detail}`, true);
      return;
    }

    this.tray = createdTray;
    this.rebuildContextMenu();
    this.bindTrayEvents(createdTray);

    if (this.platform !== 'win32' || hasNonZeroTrayBounds(createdTray)) {
      this.clearRetryTimer();
      this.setStatus({
        state: 'ready',
        available: true,
        attempts,
        message: null,
      });
      return;
    }

    // Windows 实测 Shell_NotifyIcon(NIM_ADD) 失败时不会抛出 JS 异常，而是 getBounds() 返回全 0
    this.handleCreateFailure(attempts, TRAY_UNVERIFIED_MESSAGE, false);
  }

  private bindTrayEvents(tray: Tray): void {
    const confirmReady = (): void => {
      if (this.tray !== tray) return;
      if (this.status.state !== 'ready') {
        this.clearRetryTimer();
        this.setStatus({
          state: 'ready',
          available: true,
          attempts: this.status.attempts,
          message: null,
        });
      }
    };

    // macOS 菜单栏图标绑定 contextMenu 后左键默认展开菜单，避免叠加 click 导致同时显隐 HUD
    if (this.platform !== 'darwin') {
      tray.on('click', () => {
        confirmReady();
        this.actions.onToggleHud();
      });
    }

    if (this.platform === 'win32') {
      tray.on('right-click', confirmReady);
      tray.on('double-click', confirmReady);
      tray.on('mouse-move', confirmReady);
    }
  }

  private handleCreateFailure(attempts: number, exhaustedMessage: string, hardError: boolean): void {
    const delayMs = this.retryDelaysMs[this.nextRetryIndex];
    if (delayMs !== undefined) {
      this.nextRetryIndex += 1;
      this.setStatus({
        state: 'retrying',
        available: false,
        attempts,
        message: TRAY_RETRYING_MESSAGE,
      });

      this.clearRetryTimer();
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        if (!this.initialized) return;

        // 重建前先复检当前实例：若 Explorer 已恢复并由 TaskbarCreated 激活原图标，直接转正避免闪烁
        if (this.tray && this.platform === 'win32' && hasNonZeroTrayBounds(this.tray)) {
          this.setStatus({
            state: 'ready',
            available: true,
            attempts: this.status.attempts,
            message: null,
          });
          return;
        }

        this.destroyTrayInstanceOnly();
        this.createTrayAttempt();
      }, delayMs);
      return;
    }

    // 重试耗尽后保留最后一个 Tray 实例（若创建未抛错），以便后续 Explorer 重启发送 TaskbarCreated 时自动恢复
    this.setStatus({
      state: hardError ? 'failed' : 'unverified',
      available: false,
      attempts,
      message: exhaustedMessage,
    });
  }

  private setStatus(next: TrayStatus): void {
    const changed =
      this.status.state !== next.state ||
      this.status.available !== next.available ||
      this.status.attempts !== next.attempts ||
      this.status.message !== next.message;
    this.status = next;
    if (changed) {
      this.actions.onStatusChange?.({ ...this.status });
    }
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private destroyTrayInstanceOnly(): void {
    if (this.tray) {
      try {
        this.tray.destroy();
      } catch {
        // 忽略已失效实例的清理异常
      }
      this.tray = null;
    }
  }

  private rebuildContextMenu(): void {
    if (!this.tray || !this.lastShellState) return;
    const shell = this.lastShellState;

    const template: MenuItemConstructorOptions[] = [
      {
        label: shell.hudVisible ? '隐藏悬浮窗' : '显示悬浮窗',
        click: () => this.actions.onToggleHud(),
      },
      {
        label: shell.detailVisible ? '收起详情浮层' : '展开详情浮层',
        click: () => this.actions.onToggleDetail(),
      },
      { type: 'separator' },
      {
        label: '极简模式',
        type: 'checkbox',
        checked: shell.settings.hudMode === 'minimal',
        click: (menuItem) => this.actions.onToggleMinimalMode(menuItem.checked),
      },
      {
        label: '窗口置顶',
        type: 'checkbox',
        checked: shell.settings.alwaysOnTop,
        click: (menuItem) => this.actions.onToggleAlwaysOnTop(menuItem.checked),
      },
      {
        label: '静音提醒',
        type: 'checkbox',
        checked: shell.settings.muted,
        click: (menuItem) => this.actions.onToggleMuted(menuItem.checked),
      },
      {
        label: '开机自启',
        type: 'checkbox',
        checked: shell.settings.autoLaunch,
        click: (menuItem) => this.actions.onToggleAutoLaunch(menuItem.checked),
      },
      { type: 'separator' },
      {
        label: '手动刷新行情',
        click: () => this.actions.onRefreshNow(),
      },
      {
        label: '打开设置',
        click: () => this.actions.onOpenSettings(),
      },
    ];

    if (shell.isDev && this.actions.onSimulateAlert) {
      template.push(
        { type: 'separator' },
        {
          label: '开发测试：模拟急放告警',
          click: () => this.actions.onSimulateAlert?.('SURGE'),
        },
        {
          label: '开发测试：模拟急缩告警',
          click: () => this.actions.onSimulateAlert?.('SHRINK'),
        }
      );
    }

    template.push(
      { type: 'separator' },
      {
        label: '退出',
        click: () => this.actions.onQuit(),
      }
    );

    this.tray.setContextMenu(Menu.buildFromTemplate(template));
  }

  destroy(): void {
    this.initialized = false;
    this.clearRetryTimer();
    this.destroyTrayInstanceOnly();
  }
}
