/**
 * 领域与系统常量（严格对齐 docs/PLAN.md 与 docs/DATA_SOURCES.md）
 */

export const MARKET_TOTAL_SYMBOL = 'MARKET_TOTAL';

/** 沪深两市总成交额聚合所用的唯一权威组合（不含北证，防重复累加） */
export const MARKET_TOTAL_COMPONENTS = ['000001.SH', '399106.SZ'] as const;

export type IndexScopeBadge = '全市场' | '成分股';

export interface CoreIndexMeta {
  readonly symbol: string;
  readonly name: string;
  readonly scope: IndexScopeBadge;
  readonly scopeDetail: string;
}

/** 四大核心展示指数元数据（口径依据 Phase 0 实测结论） */
export const CORE_INDICES: readonly CoreIndexMeta[] = [
  {
    symbol: '000001.SH',
    name: '上证指数',
    scope: '全市场',
    scopeDetail: '沪市全市场（含科创板）',
  },
  {
    symbol: '399001.SZ',
    name: '深证成指',
    scope: '全市场',
    scopeDetail: '深市全市场（实测与 399106.SZ 相等）',
  },
  {
    symbol: '399006.SZ',
    name: '创业板指',
    scope: '全市场',
    scopeDetail: '创业板全市场（腾讯/新浪口径与 399102.SZ 一致）',
  },
  {
    symbol: '000688.SH',
    name: '科创50',
    scope: '成分股',
    scopeDetail: '科创50成分股（50只）',
  },
] as const;

/** 盘中行情采集需要拉取的 5 只指数（含深证综指用于两市总成交额聚合） */
export const MONITORED_INDEX_SYMBOLS = [
  '000001.SH',
  '399106.SZ',
  '399001.SZ',
  '399006.SZ',
  '000688.SH',
] as const;

/** SQLite 滚动保留交易日数 */
export const DEFAULT_RETENTION_TRADING_DAYS = 30;

/** 同花顺环境变量名 */
export const HITHINK_API_KEY_ENV = 'HITHINK_FINANCE_API_KEY';

/** 软件内加密凭据文件名（存放在 Electron userData 目录） */
export const ENCRYPTED_KEY_FILENAME = 'hithink-key.enc';

/** 本地 SQLite 数据库文件名（存放在 Electron userData 目录） */
export const DATABASE_FILENAME = 'a-share-monitor.sqlite';
