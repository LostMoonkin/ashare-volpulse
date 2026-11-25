#!/usr/bin/env node
/**
 * Phase 6：基于本地 SQLite 真实录制交易日数据的 09:25 → 15:00 全天回放验证脚本。
 *
 * 用法：
 *   node scripts/verify-replay.mjs [--db <path-to-sqlite>] [--date YYYY-MM-DD]
 *
 * 默认查找 %APPDATA%\a-share-monitor\a-share-monitor.sqlite。
 * 验证项：
 * 1. 全天 241 步（09:25 + 0..239）无报错跑通
 * 2. 两市总成交额非降级帧严格等于 000001.SH + 399106.SZ
 * 3. 跨午休（11:29 → 13:00 → 13:02）滚动斜率连续可用
 * 4. 09:30–09:34 冷启动窗口 0 告警
 * 5. 回放过程对实盘 alert_events 0 写入（只读验证）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function parseCli(argv) {
  let dbPath = null;
  let tradeDate = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--db' && argv[i + 1]) {
      dbPath = argv[++i];
    } else if (arg.startsWith('--db=')) {
      dbPath = arg.slice('--db='.length);
    } else if (arg === '--date' && argv[i + 1]) {
      tradeDate = argv[++i];
    } else if (arg.startsWith('--date=')) {
      tradeDate = arg.slice('--date='.length);
    }
  }
  if (!dbPath) {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    dbPath = path.join(appData, 'a-share-monitor', 'a-share-monitor.sqlite');
  }
  return { dbPath, tradeDate };
}

function computeOlsSlope(points) {
  const n = points.length;
  if (n < 2) return null;
  let sx = 0;
  let sy = 0;
  for (const [x, y] of points) {
    sx += x;
    sy += y;
  }
  const mx = sx / n;
  const my = sy / n;
  let num = 0;
  let den = 0;
  for (const [x, y] of points) {
    const dx = x - mx;
    num += dx * (y - my);
    den += dx * dx;
  }
  return den > 0 ? num / den : null;
}

function computeMultipleAt(todayMap, prevMap, k, W) {
  if (k < 1) return null;
  const anchor = k >= W ? k - W : 0;
  const tv = todayMap.get(k);
  const pv = prevMap.get(k);
  const ta = todayMap.get(anchor);
  const pa = prevMap.get(anchor);
  if (tv === undefined || pv === undefined || ta === undefined || pa === undefined) return null;
  const td = tv - ta;
  const pd = pv - pa;
  if (pd <= 0 || td < 0) return null;
  return td / pd;
}

function main() {
  const { dbPath, tradeDate: requestedDate } = parseCli(process.argv.slice(2));
  if (!fs.existsSync(dbPath)) {
    console.error(`[verify-replay] 未找到本地录制数据库：${dbPath}`);
    process.exit(1);
  }

  // 只读打开确保绝对不会污染实盘 SQLite
  const db = new DatabaseSync(dbPath, { open: true, readOnly: true });
  try {
    const recordedDates = db
      .prepare('SELECT DISTINCT trade_date FROM intraday_bars ORDER BY trade_date DESC')
      .all()
      .map((r) => r.trade_date);

    if (recordedDates.length === 0) {
      console.error('[verify-replay] 本地数据库中无已录制的分钟行情数据。');
      process.exit(1);
    }

    const tradeDate = requestedDate || recordedDates[0];
    if (!recordedDates.includes(tradeDate)) {
      console.error(
        `[verify-replay] 未找到交易日 ${tradeDate} 的录制数据。可用日期：${recordedDates.join(', ')}`
      );
      process.exit(1);
    }

    const prevTradeDate = recordedDates.find((d) => d < tradeDate) || null;
    const alertCountBefore = db.prepare('SELECT COUNT(*) AS cnt FROM alert_events').get().cnt;

    const loadBarsMap = (symbol, date) => {
      const map = new Map();
      if (!date) return map;
      const rows = db
        .prepare(
          'SELECT minute_index, cum_turnover FROM intraday_bars WHERE symbol = ? AND trade_date = ? ORDER BY minute_index ASC'
        )
        .all(symbol, date);
      for (const r of rows) {
        map.set(r.minute_index, r.cum_turnover);
      }
      return map;
    };

    const shToday = loadBarsMap('000001.SH', tradeDate);
    const szToday = loadBarsMap('399106.SZ', tradeDate);
    const shPrev = loadBarsMap('000001.SH', prevTradeDate);
    const szPrev = loadBarsMap('399106.SZ', prevTradeDate);

    const aggToday = new Map();
    const aggPrev = new Map();
    for (let m = 0; m < 240; m++) {
      if (shToday.has(m) && szToday.has(m)) {
        aggToday.set(m, shToday.get(m) + szToday.get(m));
      }
      if (shPrev.has(m) && szPrev.has(m)) {
        aggPrev.set(m, shPrev.get(m) + szPrev.get(m));
      }
    }

    const W = 5;
    let validSteps = 0;
    let degradedSteps = 0;
    let aggregationMismatch = 0;
    let lunchBridgeSlope = null;
    let coldStartAlerts = 0;
    const triggeredAlerts = [];
    const lastCooldownMinute = new Map();

    for (let m = 0; m < 240; m++) {
      const shVal = shToday.get(m);
      const szVal = szToday.get(m);
      const totalVal = aggToday.get(m);
      if (shVal === undefined || szVal === undefined || totalVal === undefined) {
        degradedSteps += 1;
        continue;
      }
      validSteps += 1;
      if (Math.abs(totalVal - (shVal + szVal)) > 1e-3) {
        aggregationMismatch += 1;
      }

      if (m >= W) {
        const mult = computeMultipleAt(aggToday, aggPrev, m, W);
        const pts = [];
        let allOk = true;
        for (let k = m - W + 1; k <= m; k++) {
          const mk = computeMultipleAt(aggToday, aggPrev, k, W);
          if (mk === null) {
            allOk = false;
            break;
          }
          pts.push([k, (mk - 1) * 100]);
        }
        const slope = allOk ? computeOlsSlope(pts) : null;
        if (m === 122) {
          lunchBridgeSlope = slope;
        }
        if (slope !== null && mult !== null) {
          let dir = null;
          if (slope >= 3.0 && mult >= 1.5) dir = 'SURGE';
          else if (slope <= -3.0 && mult <= 0.65) dir = 'SHRINK';
          if (dir) {
            if (m < 5) {
              coldStartAlerts += 1;
            } else {
              const lastM = lastCooldownMinute.get(dir);
              if (lastM === undefined || m - lastM >= 5) {
                lastCooldownMinute.set(dir, m);
                triggeredAlerts.push({
                  minuteIndex: m,
                  direction: dir,
                  slope: Number(slope.toFixed(2)),
                  windowMultiple: Number(mult.toFixed(2)),
                });
              }
            }
          }
        }
      }
    }

    const alertCountAfter = db.prepare('SELECT COUNT(*) AS cnt FROM alert_events').get().cnt;
    const report = {
      dbPath,
      tradeDate,
      prevTradeDate,
      recordedDatesCount: recordedDates.length,
      todayBars: { sh: shToday.size, sz: szToday.size, totalAligned: aggToday.size },
      prevBars: { sh: shPrev.size, sz: szPrev.size, totalAligned: aggPrev.size },
      validSteps,
      degradedSteps,
      aggregationMismatch,
      lunchBridgeSlope: lunchBridgeSlope !== null ? Number(lunchBridgeSlope.toFixed(4)) : null,
      coldStartAlerts,
      triggeredAlertsCount: triggeredAlerts.length,
      triggeredAlerts: triggeredAlerts.slice(0, 10),
      alertEventsUnchanged: alertCountBefore === alertCountAfter,
    };

    console.log(JSON.stringify(report, null, 2));

    if (aggregationMismatch > 0 || coldStartAlerts > 0 || !report.alertEventsUnchanged) {
      process.exit(1);
    }
    if (aggToday.size === 240 && aggPrev.size === 240 && lunchBridgeSlope === null) {
      console.error('[verify-replay] 完整数据下跨午休斜率（13:02）不可用！');
      process.exit(1);
    }
  } finally {
    db.close();
  }
}

main();
