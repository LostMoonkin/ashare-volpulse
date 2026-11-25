import { afterEach, describe, expect, it } from 'vitest';
import { AppDatabase } from '../../src/main/storage/database';
import {
  DEFAULT_MONITOR_CONFIG,
  MonitorSettingsStore,
  sanitizeMonitorConfig,
} from '../../src/main/storage/monitorSettingsStore';

const openDbs: AppDatabase[] = [];

function createMemoryDb(): AppDatabase {
  const db = new AppDatabase(':memory:');
  openDbs.push(db);
  return db;
}

afterEach(() => {
  while (openDbs.length > 0) {
    openDbs.pop()?.close();
  }
});

describe('MonitorSettingsStore', () => {
  it('returns defaults when app_settings has no monitor.config', () => {
    const db = createMemoryDb();
    const store = new MonitorSettingsStore(db);
    expect(store.load()).toEqual(DEFAULT_MONITOR_CONFIG);
  });

  it('persists updates across reloads and clamps out-of-range fields safely', () => {
    const db = createMemoryDb();
    const store = new MonitorSettingsStore(db);

    const updated = store.update({
      pollingIntervalSec: 25, // 应钳制到 15
      expandThresholdPct: 8.5,
      shrinkThresholdPct: 7.5, // 正数自动规范为 -7.5
      slopeWindow: 10,
      surgeSlopeThreshold: 1.8,
      surgeMultipleThreshold: 1.9,
      shrinkSlopeThreshold: -1.6,
      shrinkMultipleThreshold: 0.55,
      matchMode: 'OR',
      cooldownMinutes: 8,
      alertsEnabled: false,
    });

    expect(updated).toEqual({
      pollingIntervalSec: 15,
      expandThresholdPct: 8.5,
      shrinkThresholdPct: -7.5,
      slopeWindow: 10,
      alertsEnabled: false,
      surgeSlopeThreshold: 1.8,
      surgeMultipleThreshold: 1.9,
      shrinkSlopeThreshold: -1.6,
      shrinkMultipleThreshold: 0.55,
      matchMode: 'OR',
      cooldownMinutes: 8,
    });

    // 模拟重启重新加载
    const reloaded = new MonitorSettingsStore(db).load();
    expect(reloaded).toEqual(updated);

    // 非法斜率窗口回退到已有合法值
    const sanitized = sanitizeMonitorConfig({ slopeWindow: 7 as unknown as 5 }, reloaded);
    expect(sanitized.slopeWindow).toBe(10);
  });
});
