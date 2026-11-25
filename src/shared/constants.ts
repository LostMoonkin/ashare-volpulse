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

/** 默认展示的四大核心板块指数元数据（上、深、双创全市场口径，依据实测结论） */
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
    symbol: '000680.SH',
    name: '科创综指',
    scope: '全市场',
    scopeDetail: '科创板全市场（四源实测一致）',
  },
] as const;

/** 可选扩展展示指数元数据（默认关闭，可在设置中按需开启） */
export const OPTIONAL_INDICES: readonly CoreIndexMeta[] = [
  {
    symbol: '000016.SH',
    name: '上证50',
    scope: '成分股',
    scopeDetail: '上证50成分股（50只）',
  },
  {
    symbol: '000300.SH',
    name: '沪深300',
    scope: '成分股',
    scopeDetail: '沪深300成分股（300只）',
  },
  {
    symbol: '000852.SH',
    name: '中证1000',
    scope: '成分股',
    scopeDetail: '中证1000成分股（1000只）',
  },
  {
    symbol: '000688.SH',
    name: '科创50',
    scope: '成分股',
    scopeDetail: '科创50成分股（50只）',
  },
] as const;

export const OPTIONAL_INDEX_SYMBOLS = [
  '000016.SH',
  '000300.SH',
  '000852.SH',
  '000688.SH',
] as const;

export type OptionalIndexSymbol = (typeof OPTIONAL_INDEX_SYMBOLS)[number];

/** 盘中行情采集默认必拉取的 5 只基础指数（含深证综指用于两市总成交额聚合） */
export const MONITORED_INDEX_SYMBOLS = [
  '000001.SH',
  '399106.SZ',
  '399001.SZ',
  '399006.SZ',
  '000680.SH',
] as const;

/** 全部受管大盘/宽基指数代码（基础必采 5 只 + 可选扩展 4 只） */
export const ALL_INDEX_SYMBOLS = [
  ...MONITORED_INDEX_SYMBOLS,
  ...OPTIONAL_INDEX_SYMBOLS,
] as const;

/** 全部受管指数标准名称映射（用于同花顺等不返回 name 的快照源补全与告警展示） */
export const MONITORED_INDEX_NAMES: Readonly<Record<string, string>> = {
  '000001.SH': '上证指数',
  '399106.SZ': '深证综指',
  '399001.SZ': '深证成指',
  '399006.SZ': '创业板指',
  '000680.SH': '科创综指',
  '000016.SH': '上证50',
  '000300.SH': '沪深300',
  '000852.SH': '中证1000',
  '000688.SH': '科创50',
};

const OPTIONAL_INDEX_SYMBOL_SET = new Set<string>(OPTIONAL_INDEX_SYMBOLS);

/** 规范化已启用的可选指数列表（过滤非法值、去重并保持固定展示顺序） */
export function normalizeEnabledOptionalIndices(
  raw: readonly unknown[] | null | undefined
): OptionalIndexSymbol[] {
  if (!Array.isArray(raw)) return [];
  const enabled = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const upper = item.trim().toUpperCase();
    if (OPTIONAL_INDEX_SYMBOL_SET.has(upper)) {
      enabled.add(upper);
    }
  }
  return OPTIONAL_INDEX_SYMBOLS.filter((sym) => enabled.has(sym));
}

/** 按配置解析当前面板应展示的指数列表（固定核心 4 指数 + 已开启的可选指数） */
export function resolveDisplayedIndices(
  enabledOptionalIndices?: readonly string[]
): CoreIndexMeta[] {
  const enabledSet = new Set<string>(normalizeEnabledOptionalIndices(enabledOptionalIndices));
  return [
    ...CORE_INDICES,
    ...OPTIONAL_INDICES.filter((meta) => enabledSet.has(meta.symbol)),
  ];
}

/** 按配置解析当前调度器应采集的指数代码集合（必采 5 指数 + 已开启的可选指数） */
export function resolveMonitoredIndexSymbols(
  enabledOptionalIndices?: readonly string[]
): string[] {
  const optional = normalizeEnabledOptionalIndices(enabledOptionalIndices);
  return [...MONITORED_INDEX_SYMBOLS, ...optional];
}

/** 盘中轮询频率与退避预算（依据 Phase 0 压测结论） */
export const DEFAULT_POLLING_INTERVAL_SEC = 3;
export const MIN_POLLING_INTERVAL_SEC = 3;
export const MAX_POLLING_INTERVAL_SEC = 15;
export const MAX_BACKOFF_INTERVAL_SEC = 30;
/** 同花顺紧急兜底最低轮询间隔（秒），严禁进入秒级高频轮询 */
export const HITHINK_FALLBACK_MIN_INTERVAL_SEC = 15;
/** 单次批量快照请求最大标的数 */
export const MAX_BATCH_SNAPSHOT_SYMBOLS = 50;
/** 切至备用源后探测主源恢复的间隔（5 分钟） */
export const PRIMARY_RECOVERY_PROBE_INTERVAL_MS = 5 * 60 * 1000;
/** 连续失败达到该次数时触发主备快照源切换 */
export const FAILOVER_FAILURE_THRESHOLD = 3;
/** SQLite 中记录交易日历最近同步日期的 app_settings 键名 */
export const SETTING_CALENDAR_SYNC_DATE = 'calendar.lastSyncedDate';

/** SQLite 滚动保留交易日数 */
export const DEFAULT_RETENTION_TRADING_DAYS = 30;

/** 同花顺环境变量名 */
export const HITHINK_API_KEY_ENV = 'HITHINK_FINANCE_API_KEY';

/** 软件内加密凭据文件名（存放在 Electron userData 目录） */
export const ENCRYPTED_KEY_FILENAME = 'hithink-key.enc';

/** 本地 SQLite 数据库文件名（存放在 Electron userData 目录） */
export const DATABASE_FILENAME = 'a-share-monitor.sqlite';

/** Windows AppUserModelId（保证开发态与便携版原生 Toast 通知正常弹出） */
export const APP_USER_MODEL_ID = 'com.asharemonitor.app';

/** 桌面外壳持久化设置键（存入 SQLite app_settings） */
export const SETTING_HUD_POSITION = 'shell.hudPosition';
export const SETTING_HUD_OPACITY = 'shell.hudOpacity';
export const SETTING_ALWAYS_ON_TOP = 'shell.alwaysOnTop';
export const SETTING_MUTED = 'shell.muted';
export const SETTING_BOSS_KEY = 'shell.bossKey';
export const SETTING_AUTO_LAUNCH = 'shell.autoLaunch';
export const SETTING_HUD_MODE = 'shell.hudMode';
export const SETTING_MONITOR_CONFIG = 'monitor.config';

/** 可选滚动斜率窗口（分钟） */
export const ALLOWED_SLOPE_WINDOWS = [3, 5, 10] as const;

/** 桌面外壳默认参数 */
export const DEFAULT_HUD_OPACITY = 0.9;
export const MIN_HUD_OPACITY = 0.3;
export const MAX_HUD_OPACITY = 1.0;
export const DEFAULT_BOSS_KEY = 'Alt+Shift+A';
export const DEFAULT_HUD_MODE = 'standard' as const;
export const HUD_MINIMAL_WATCHLIST_LIMIT = 3;

/** 双态窗口默认尺寸（像素） */
export const HUD_DEFAULT_WIDTH = 400;
export const HUD_DEFAULT_HEIGHT = 456;
export const HUD_MINIMAL_WIDTH = 320;
export const HUD_MINIMAL_HEIGHT = 212;
export const DETAIL_DEFAULT_WIDTH = 960;
export const DETAIL_DEFAULT_HEIGHT = 640;
export const DETAIL_MIN_WIDTH = 780;
export const DETAIL_MIN_HEIGHT = 520;

/** 开发态模拟测试告警的统一标记前缀（严禁伪装成实盘告警） */
export const SIMULATED_ALERT_PREFIX = '[模拟测试]';

/** 全天历史回放告警的统一标记前缀（不入实盘库、不弹系统通知） */
export const REPLAY_ALERT_PREFIX = '[回放]';

/** 全天回放默认每帧间隔（毫秒），约 29 秒跑完 09:25 → 15:00 全天 */
export const DEFAULT_REPLAY_STEP_MS = 120;
