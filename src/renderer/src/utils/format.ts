import type { MarketPhaseType, VolumeStateType } from '../../../shared/types';
export { resolveSymbolChangePct, resolveSymbolTurnover } from '../../../shared/snapshotView';

export function formatTurnover(amountYuan: number | null | undefined): string {
  if (amountYuan === null || amountYuan === undefined || !Number.isFinite(amountYuan)) {
    return '—';
  }
  const abs = Math.abs(amountYuan);
  const sign = amountYuan < 0 ? '-' : '';
  if (abs >= 1e12) {
    return `${sign}${(abs / 1e12).toFixed(2)} 万亿`;
  }
  if (abs >= 1e8) {
    return `${sign}${(abs / 1e8).toFixed(1)} 亿`;
  }
  if (abs >= 1e4) {
    return `${sign}${Math.round(abs / 1e4).toLocaleString('zh-CN')} 万`;
  }
  return `${sign}${Math.round(abs)} 元`;
}

export function formatSignedTurnover(amountYuan: number | null | undefined): string {
  if (amountYuan === null || amountYuan === undefined || !Number.isFinite(amountYuan)) {
    return '—';
  }
  const formatted = formatTurnover(Math.abs(amountYuan));
  if (amountYuan > 0) return `+${formatted}`;
  if (amountYuan < 0) return `-${formatted}`;
  return formatted;
}

export function formatSignedPct(pct: number | null | undefined, digits = 1): string {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) {
    return '—';
  }
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(digits)}%`;
}

export function formatVolumeState(state: VolumeStateType | undefined): {
  label: string;
  tone: 'up' | 'down' | 'flat' | 'muted';
} {
  switch (state) {
    case 'EXPANDING':
      return { label: '放量', tone: 'up' };
    case 'SHRINKING':
      return { label: '缩量', tone: 'down' };
    case 'FLAT':
      return { label: '平量', tone: 'flat' };
    default:
      return { label: '待比对', tone: 'muted' };
  }
}

export function formatPhaseLabel(phase: MarketPhaseType | undefined): string {
  switch (phase) {
    case 'PRE_MARKET':
      return '盘前';
    case 'OPEN_AUCTION':
      return '集合竞价';
    case 'AUCTION_GAP':
      return '竞价间隙';
    case 'MORNING_SESSION':
      return '早盘交易';
    case 'LUNCH_BREAK':
      return '午休折叠';
    case 'AFTERNOON_SESSION':
      return '午盘交易';
    case 'POST_MARKET':
      return '盘后复盘';
    case 'CLOSED_DAY':
      return '休市复盘';
    default:
      return '初始化';
  }
}

export function formatClockTime(timestampMs: number | null | undefined): string {
  if (!timestampMs || !Number.isFinite(timestampMs)) return '—';
  const d = new Date(timestampMs);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}
