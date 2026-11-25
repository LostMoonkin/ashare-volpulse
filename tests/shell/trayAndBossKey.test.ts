import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  globalShortcut: {
    register: vi.fn(),
    unregister: vi.fn(),
    isRegistered: vi.fn(),
  },
  nativeImage: {
    createFromBuffer: vi.fn(() => ({ resize: vi.fn() })),
  },
  Menu: { buildFromTemplate: vi.fn() },
  Tray: vi.fn(),
}));

import {
  BossKeyManager,
  formatTrayTooltip,
  generateTrayIconPng,
  resolveTrayIconMood,
  type GlobalShortcutApi,
} from '../../src/main/tray';
import type { MarketDashboardState } from '../../src/shared/types';

function makeDashboardState(overrides?: {
  cumTurnover?: number | null;
  volumeState?: 'EXPANDING' | 'FLAT' | 'SHRINKING' | 'UNAVAILABLE';
  cumRatioPct?: number | null;
  degraded?: boolean;
  stale?: boolean;
}): MarketDashboardState {
  const cumTurnover = overrides && 'cumTurnover' in overrides ? overrides.cumTurnover ?? null : 1.28e12;
  return {
    status: {
      mode: 'LIVE',
      phase: 'MORNING_SESSION',
      tradeDate: '2026-11-25',
      prevTradeDate: '2026-11-24',
      activeSnapshotProvider: 'tencent',
      activeIntradayProvider: 'tencent',
      calendarSource: 'sqlite_cache',
      calendarDegraded: false,
      pollingIntervalSec: 3,
      configuredIntervalSec: 3,
      lastUpdatedAt: Date.now(),
      lastLatencyMs: 68,
      consecutiveFailures: 0,
      stale: overrides?.stale ?? false,
      degraded: overrides?.degraded ?? false,
      degradedReasons: overrides?.degraded ? ['主源超时'] : [],
    },
    marketTotal: {
      symbol: 'MARKET_TOTAL',
      name: '沪深两市',
      tradeDate: '2026-11-25',
      prevTradeDate: '2026-11-24',
      cumTurnover,
      shTurnover: cumTurnover ? cumTurnover * 0.45 : null,
      szTurnover: cumTurnover ? cumTurnover * 0.55 : null,
      auctionTurnover: null,
      prevAuctionTurnover: null,
      prevFullDayTurnover: 1.5e12,
      metrics:
        cumTurnover === null
          ? null
          : {
              minuteIndex: 60,
              elapsedSeconds: 30,
              todayCumTurnover: cumTurnover,
              prevAlignedCumTurnover: 1.14e12,
              cumDiff: 1.4e11,
              cumRatio: 0.124,
              cumRatioPct: overrides?.cumRatioPct ?? 12.4,
              predictedFullDayTurnover: 1.68e12,
              volumeState: overrides?.volumeState ?? 'EXPANDING',
              slope: 0.85,
              windowMultiple: 1.25,
              slopeWindow: 5,
            },
      todaySeries: [],
      prevSeries: [],
      degraded: overrides?.degraded ?? false,
      degradedReason: overrides?.degraded ? '数据降级' : null,
    },
    indices: [],
    watchlist: [],
    recentAlerts: [],
  };
}

describe('trayTooltip and trayIcon', () => {
  it('formats tooltip for initializing, expanding, shrinking, and degraded states', () => {
    expect(formatTrayTooltip(null)).toContain('数据初始化中');

    const expanding = formatTrayTooltip(
      makeDashboardState({ cumTurnover: 1.28e12, volumeState: 'EXPANDING', cumRatioPct: 12.4 })
    );
    expect(expanding).toContain('1.28万亿');
    expect(expanding).toContain('放量');
    expect(expanding).toContain('+12.4%');

    const shrinking = formatTrayTooltip(
      makeDashboardState({ cumTurnover: 8.64e11, volumeState: 'SHRINKING', cumRatioPct: -8.6 })
    );
    expect(shrinking).toContain('8640.0亿');
    expect(shrinking).toContain('缩量');
    expect(shrinking).toContain('-8.6%');

    const degradedWithVal = formatTrayTooltip(
      makeDashboardState({ cumTurnover: 1.05e12, volumeState: 'FLAT', degraded: true, stale: true })
    );
    expect(degradedWithVal).toContain('降级');
    expect(degradedWithVal).toContain('陈旧');

    const degradedMissing = formatTrayTooltip(
      makeDashboardState({ cumTurnover: null, degraded: true })
    );
    expect(degradedMissing).toContain('不可用');
    expect(degradedMissing).toContain('降级');
    expect(degradedMissing).not.toContain('0元');
  });

  it('generates valid distinct PNG buffers for all tray icon moods', () => {
    const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const exp = generateTrayIconPng('expanding');
    const shr = generateTrayIconPng('shrinking');
    const flt = generateTrayIconPng('flat');
    const deg = generateTrayIconPng('degraded');

    for (const buf of [exp, shr, flt, deg]) {
      expect(buf.subarray(0, 8).equals(pngSignature)).toBe(true);
      expect(buf.length).toBeGreaterThan(60);
    }
    expect(exp.equals(shr)).toBe(false);
    expect(exp.equals(deg)).toBe(false);

    expect(resolveTrayIconMood(makeDashboardState({ volumeState: 'EXPANDING' }))).toBe('expanding');
    expect(resolveTrayIconMood(makeDashboardState({ volumeState: 'SHRINKING' }))).toBe('shrinking');
    expect(resolveTrayIconMood(makeDashboardState({ degraded: true }))).toBe('degraded');
  });
});

describe('BossKeyManager', () => {
  function createFakeShortcutApi(occupiedKeys: Set<string>): {
    api: GlobalShortcutApi;
    registered: Map<string, () => void>;
  } {
    const registered = new Map<string, () => void>();
    const api: GlobalShortcutApi = {
      register: (acc, cb) => {
        if (occupiedKeys.has(acc) || registered.has(acc)) {
          return false;
        }
        registered.set(acc, cb);
        return true;
      },
      unregister: (acc) => {
        registered.delete(acc);
      },
      isRegistered: (acc) => registered.has(acc),
    };
    return { api, registered };
  }

  it('registers initial shortcut, handles conflict, and preserves old binding on rebind conflict', () => {
    const occupied = new Set<string>(['Ctrl+Shift+X']);
    const { api, registered } = createFakeShortcutApi(occupied);
    const onTrigger = vi.fn();
    const onConflict = vi.fn();

    const manager = new BossKeyManager({
      shortcutApi: api,
      onTrigger,
      onConflict,
    });

    // 初始注册成功
    const initStatus = manager.registerInitial('Alt+Shift+A');
    expect(initStatus).toEqual({
      accelerator: 'Alt+Shift+A',
      registered: true,
      conflictMessage: null,
    });
    registered.get('Alt+Shift+A')?.();
    expect(onTrigger).toHaveBeenCalledTimes(1);

    // 改绑到被占用快捷键 → 返回冲突提示，但保留原 Alt+Shift+A
    const failedRebind = manager.rebind('Ctrl+Shift+X');
    expect(failedRebind.success).toBe(false);
    expect(failedRebind.committedAccelerator).toBe('Alt+Shift+A');
    expect(failedRebind.status.registered).toBe(true);
    expect(failedRebind.status.conflictMessage).toContain('已被其他应用占用');
    expect(registered.has('Alt+Shift+A')).toBe(true);
    expect(onConflict).toHaveBeenCalledTimes(1);

    // 改绑到空闲快捷键 → 解绑旧键并生效新键
    const okRebind = manager.rebind('Alt+Shift+Z');
    expect(okRebind.success).toBe(true);
    expect(okRebind.committedAccelerator).toBe('Alt+Shift+Z');
    expect(okRebind.status.conflictMessage).toBeNull();
    expect(registered.has('Alt+Shift+A')).toBe(false);
    expect(registered.has('Alt+Shift+Z')).toBe(true);

    manager.unregister();
    expect(registered.size).toBe(0);
  });

  it('reports initial conflict clearly when default accelerator is already taken', () => {
    const { api } = createFakeShortcutApi(new Set(['Alt+Shift+A']));
    const onConflict = vi.fn();
    const manager = new BossKeyManager({
      shortcutApi: api,
      onTrigger: vi.fn(),
      onConflict,
    });

    const status = manager.registerInitial('Alt+Shift+A');
    expect(status.registered).toBe(false);
    expect(status.conflictMessage).toContain('Alt+Shift+A');
    expect(onConflict).toHaveBeenCalledTimes(1);
  });
});
