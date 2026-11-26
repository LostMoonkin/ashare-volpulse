import {
  DEFAULT_BOSS_KEY,
  DEFAULT_HUD_MODE,
  DEFAULT_HUD_OPACITY,
  SETTING_ALWAYS_ON_TOP,
  SETTING_AUTO_LAUNCH,
  SETTING_BOSS_KEY,
  SETTING_HUD_MODE,
  SETTING_HUD_OPACITY,
  SETTING_HUD_POSITION,
  SETTING_HUD_SIZE,
  SETTING_MUTED,
} from '../../shared/constants';
import type {
  DesktopShellSettings,
  HudMode,
  WindowPosition,
  WindowSize,
} from '../../shared/types';
import type { AppDatabase } from '../storage/database';
import { clampHudOpacity, clampHudStandardSize } from './windowGeometry';

function parseHudMode(raw: unknown): HudMode {
  return raw === 'minimal' ? 'minimal' : DEFAULT_HUD_MODE;
}

function parseWindowPosition(raw: unknown): WindowPosition | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as { x?: unknown; y?: unknown };
  if (typeof candidate.x !== 'number' || typeof candidate.y !== 'number') return null;
  if (!Number.isFinite(candidate.x) || !Number.isFinite(candidate.y)) return null;
  return {
    x: Math.round(candidate.x),
    y: Math.round(candidate.y),
  };
}

function parseWindowSize(raw: unknown): WindowSize | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as { width?: unknown; height?: unknown };
  if (typeof candidate.width !== 'number' || typeof candidate.height !== 'number') return null;
  if (!Number.isFinite(candidate.width) || !Number.isFinite(candidate.height)) return null;
  if (candidate.width <= 0 || candidate.height <= 0) return null;
  return clampHudStandardSize({ width: candidate.width, height: candidate.height });
}

/**
 * 桌面外壳设置持久化仓库（存入 SQLite app_settings 表）。
 * 覆盖窗口位置、标准模式尺寸、透明度、置顶、静音、老板键与开机自启开关。
 */
export class ShellSettingsStore {
  private readonly db: AppDatabase;

  constructor(db: AppDatabase) {
    this.db = db;
  }

  load(): DesktopShellSettings {
    const rawPosition = this.db.getSetting<unknown>(SETTING_HUD_POSITION);
    const rawSize = this.db.getSetting<unknown>(SETTING_HUD_SIZE);
    const rawOpacity = this.db.getSetting<unknown>(SETTING_HUD_OPACITY);
    const rawAlwaysOnTop = this.db.getSetting<unknown>(SETTING_ALWAYS_ON_TOP);
    const rawMuted = this.db.getSetting<unknown>(SETTING_MUTED);
    const rawBossKey = this.db.getSetting<unknown>(SETTING_BOSS_KEY);
    const rawAutoLaunch = this.db.getSetting<unknown>(SETTING_AUTO_LAUNCH);
    const rawHudMode = this.db.getSetting<unknown>(SETTING_HUD_MODE);

    return {
      hudPosition: parseWindowPosition(rawPosition),
      hudSize: parseWindowSize(rawSize),
      hudOpacity:
        typeof rawOpacity === 'number' ? clampHudOpacity(rawOpacity) : DEFAULT_HUD_OPACITY,
      alwaysOnTop: typeof rawAlwaysOnTop === 'boolean' ? rawAlwaysOnTop : true,
      muted: typeof rawMuted === 'boolean' ? rawMuted : false,
      bossKey:
        typeof rawBossKey === 'string' && rawBossKey.trim().length > 0
          ? rawBossKey.trim()
          : DEFAULT_BOSS_KEY,
      autoLaunch: typeof rawAutoLaunch === 'boolean' ? rawAutoLaunch : false,
      hudMode: parseHudMode(rawHudMode),
    };
  }

  setHudPosition(position: WindowPosition): WindowPosition {
    const normalized: WindowPosition = {
      x: Math.round(position.x),
      y: Math.round(position.y),
    };
    this.db.setSetting(SETTING_HUD_POSITION, normalized);
    return normalized;
  }

  setHudSize(size: WindowSize): WindowSize {
    const normalized = clampHudStandardSize(size);
    this.db.setSetting(SETTING_HUD_SIZE, normalized);
    return normalized;
  }

  setHudOpacity(opacity: number): number {
    const normalized = clampHudOpacity(opacity);
    this.db.setSetting(SETTING_HUD_OPACITY, normalized);
    return normalized;
  }

  setAlwaysOnTop(alwaysOnTop: boolean): boolean {
    const normalized = Boolean(alwaysOnTop);
    this.db.setSetting(SETTING_ALWAYS_ON_TOP, normalized);
    return normalized;
  }

  setMuted(muted: boolean): boolean {
    const normalized = Boolean(muted);
    this.db.setSetting(SETTING_MUTED, normalized);
    return normalized;
  }

  setBossKey(accelerator: string): string {
    const normalized = accelerator.trim() || DEFAULT_BOSS_KEY;
    this.db.setSetting(SETTING_BOSS_KEY, normalized);
    return normalized;
  }

  setAutoLaunch(enabled: boolean): boolean {
    const normalized = Boolean(enabled);
    this.db.setSetting(SETTING_AUTO_LAUNCH, normalized);
    return normalized;
  }

  setHudMode(mode: HudMode): HudMode {
    const normalized = parseHudMode(mode);
    this.db.setSetting(SETTING_HUD_MODE, normalized);
    return normalized;
  }
}
