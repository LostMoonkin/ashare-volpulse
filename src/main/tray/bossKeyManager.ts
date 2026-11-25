import { globalShortcut } from 'electron';
import type { BossKeyStatus } from '../../shared/types';

export interface GlobalShortcutApi {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
  isRegistered(accelerator: string): boolean;
}

export interface BossKeyManagerOptions {
  shortcutApi?: GlobalShortcutApi;
  onTrigger: () => void;
  onConflict?: (status: BossKeyStatus) => void;
}

const defaultShortcutApi: GlobalShortcutApi = {
  register: (acc, cb) => globalShortcut.register(acc, cb),
  unregister: (acc) => globalShortcut.unregister(acc),
  isRegistered: (acc) => globalShortcut.isRegistered(acc),
};

/**
 * 全局老板键管理器：
 * - 支持启动注册与运行时改绑
 * - 注册失败（被其他程序占用或格式非法）时给出明确冲突提示
 * - 运行时改绑失败时保留原快捷键不丢失
 */
export class BossKeyManager {
  private readonly api: GlobalShortcutApi;
  private readonly onTrigger: () => void;
  private readonly onConflict?: (status: BossKeyStatus) => void;

  private activeAccelerator: string | null = null;
  private status: BossKeyStatus = {
    accelerator: '',
    registered: false,
    conflictMessage: null,
  };

  constructor(options: BossKeyManagerOptions) {
    this.api = options.shortcutApi ?? defaultShortcutApi;
    this.onTrigger = options.onTrigger;
    this.onConflict = options.onConflict;
  }

  getStatus(): BossKeyStatus {
    return { ...this.status };
  }

  registerInitial(accelerator: string): BossKeyStatus {
    const normalized = accelerator.trim();
    if (!normalized) {
      this.status = {
        accelerator: '',
        registered: false,
        conflictMessage: '老板键不能为空，请在设置中配置组合键（如 Alt+Shift+A）。',
      };
      this.onConflict?.(this.getStatus());
      return this.getStatus();
    }

    let ok = false;
    try {
      ok = this.api.register(normalized, this.onTrigger);
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      this.status = {
        accelerator: normalized,
        registered: false,
        conflictMessage: `老板键 "${normalized}" 格式无效或注册异常：${reason}`,
      };
      this.onConflict?.(this.getStatus());
      return this.getStatus();
    }

    if (ok) {
      this.activeAccelerator = normalized;
      this.status = {
        accelerator: normalized,
        registered: true,
        conflictMessage: null,
      };
    } else {
      this.activeAccelerator = null;
      this.status = {
        accelerator: normalized,
        registered: false,
        conflictMessage: `老板键 "${normalized}" 已被其他应用占用，请更换组合键。`,
      };
      this.onConflict?.(this.getStatus());
    }

    return this.getStatus();
  }

  /**
   * 运行时改绑老板键：
   * - 新快捷键注册成功：解绑旧快捷键并切换
   * - 新快捷键被占用或格式无效：保留旧快捷键并反馈冲突原因
   */
  rebind(newAccelerator: string): {
    success: boolean;
    committedAccelerator: string | null;
    status: BossKeyStatus;
  } {
    const normalized = newAccelerator.trim();
    if (!normalized) {
      const conflict: BossKeyStatus = {
        accelerator: this.activeAccelerator ?? this.status.accelerator,
        registered: this.activeAccelerator !== null,
        conflictMessage: '老板键不能为空，请输入有效组合键（例如 Alt+Shift+A）。',
      };
      this.status = conflict;
      this.onConflict?.(this.getStatus());
      return { success: false, committedAccelerator: this.activeAccelerator, status: this.getStatus() };
    }

    if (this.activeAccelerator === normalized && this.status.registered) {
      this.status = {
        accelerator: normalized,
        registered: true,
        conflictMessage: null,
      };
      return { success: true, committedAccelerator: normalized, status: this.getStatus() };
    }

    let ok = false;
    let errorDetail: string | null = null;
    try {
      ok = this.api.register(normalized, this.onTrigger);
    } catch (err: unknown) {
      errorDetail = err instanceof Error ? err.message : String(err);
      ok = false;
    }

    if (!ok) {
      const message = errorDetail
        ? `老板键 "${normalized}" 格式无效或注册失败：${errorDetail}`
        : `老板键 "${normalized}" 已被其他应用占用，已保留原快捷键${this.activeAccelerator ? ` "${this.activeAccelerator}"` : ''}。`;
      this.status = {
        accelerator: this.activeAccelerator ?? normalized,
        registered: this.activeAccelerator !== null,
        conflictMessage: message,
      };
      this.onConflict?.(this.getStatus());
      return { success: false, committedAccelerator: this.activeAccelerator, status: this.getStatus() };
    }

    if (this.activeAccelerator && this.activeAccelerator !== normalized) {
      try {
        this.api.unregister(this.activeAccelerator);
      } catch {
        // 忽略旧键解绑异常
      }
    }

    this.activeAccelerator = normalized;
    this.status = {
      accelerator: normalized,
      registered: true,
      conflictMessage: null,
    };
    return { success: true, committedAccelerator: normalized, status: this.getStatus() };
  }

  unregister(): void {
    if (this.activeAccelerator) {
      try {
        this.api.unregister(this.activeAccelerator);
      } catch {
        // 忽略退出时清理异常
      }
      this.activeAccelerator = null;
    }
    this.status = {
      ...this.status,
      registered: false,
    };
  }
}
