import { afterEach, describe, expect, it } from 'vitest';
import { minuteIndexToLabel } from '../../src/core';
import { AppDatabase } from '../../src/main/storage/database';
import {
  loadMarketTotalPredictionProfile,
  loadSymbolPredictionProfile,
} from '../../src/main/storage/predictionProfileLoader';
import type { IntradayBarRow } from '../../src/shared/types';

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

function seedSymbolDay(
  db: AppDatabase,
  symbol: string,
  tradeDate: string,
  m0Share: number,
  fullDay: number
): void {
  const m0 = fullDay * m0Share;
  const step = (fullDay - m0) / 239;
  const bars: IntradayBarRow[] = [];
  for (let m = 0; m < 240; m++) {
    const cum = m === 0 ? m0 : m0 + step * m;
    bars.push({
      symbol,
      tradeDate,
      minuteIndex: m,
      minuteStr: minuteIndexToLabel(m),
      price: 3300,
      cumVolume: 1_000_000,
      cumTurnover: cum,
      barTurnover: m === 0 ? m0 : step,
      source: 'tencent',
    });
  }
  db.upsertIntradayBars(bars);
  db.upsertAuctionSnapshot({
    symbol,
    tradeDate,
    openPrice: 3300,
    auctionTurnover: m0 * 0.3,
    capturedAt: Date.now(),
  });
}

describe('predictionProfileLoader', () => {
  it('loads multi-day symbol and MARKET_TOTAL profiles strictly before current tradeDate', () => {
    const db = createMemoryDb();
    seedSymbolDay(db, '000001.SH', '2026-11-20', 0.05, 6000);
    seedSymbolDay(db, '399106.SZ', '2026-11-20', 0.05, 8000);

    seedSymbolDay(db, '000001.SH', '2026-11-23', 0.05, 7000);
    seedSymbolDay(db, '399106.SZ', '2026-11-23', 0.05, 9000);

    seedSymbolDay(db, '000001.SH', '2026-11-24', 0.11, 8000);
    seedSymbolDay(db, '399106.SZ', '2026-11-24', 0.11, 10000);

    // 当日（2026-11-25）不应混入历史模板
    seedSymbolDay(db, '000001.SH', '2026-11-25', 0.2, 12000);
    seedSymbolDay(db, '399106.SZ', '2026-11-25', 0.2, 12000);

    const shProfile = loadSymbolPredictionProfile(db, '000001.SH', '2026-11-25', 10);
    expect(shProfile).not.toBeNull();
    expect(shProfile!.sampleDays).toBe(3);
    expect(shProfile!.avgFullDayTurnover).toBeCloseTo((6000 + 7000 + 8000) / 3, 6);
    expect(shProfile!.minuteShares.get(0)).toBeCloseTo((0.05 + 0.05 + 0.11) / 3, 6);

    const totalProfile = loadMarketTotalPredictionProfile(db, '2026-11-25', 10);
    expect(totalProfile).not.toBeNull();
    expect(totalProfile!.sampleDays).toBe(3);
    // 3 天两市合计全天分别为 14000, 16000, 18000 → 均值 16000
    expect(totalProfile!.avgFullDayTurnover).toBeCloseTo(16_000, 6);
    expect(totalProfile!.minuteShares.get(0)).toBeCloseTo((0.05 + 0.05 + 0.11) / 3, 6);
    expect(totalProfile!.minuteShares.get(239)).toBe(1);
  });
});
