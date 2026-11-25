import { describe, expect, it } from 'vitest';
import {
  formatClockTime,
  formatPhaseLabel,
  formatPrice,
  formatSignedPct,
  formatSignedTurnover,
  formatSlopeTrend,
  formatTurnover,
  formatVolumeState,
  getSignedToneClass,
  getSignedToneColor,
} from '../../src/renderer/src/utils/format';

describe('renderer format utils', () => {
  it('formats turnover, signed metrics, phase/volume labels, and Asia/Shanghai clock time', () => {
    expect(formatTurnover(1.28e12)).toBe('1.28 万亿');
    expect(formatTurnover(864.5e8)).toBe('864.5 亿');
    expect(formatTurnover(5820e4)).toBe('5,820 万');
    expect(formatTurnover(null)).toBe('—');

    expect(formatSignedTurnover(842e8)).toBe('+842.0 亿');
    expect(formatSignedTurnover(-320e8)).toBe('-320.0 亿');
    expect(formatSignedTurnover(0)).toBe('0 元');

    expect(formatSignedPct(12.44, 1)).toBe('+12.4%');
    expect(formatSignedPct(-5.2, 1)).toBe('-5.2%');
    expect(formatSignedPct(0, 2)).toBe('0.00%');

    expect(formatVolumeState('EXPANDING')).toEqual({ label: '放量', tone: 'up' });
    expect(formatVolumeState('SHRINKING')).toEqual({ label: '缩量', tone: 'down' });
    expect(formatPhaseLabel('LUNCH_BREAK')).toBe('午休折叠');
    expect(formatPhaseLabel('POST_MARKET')).toBe('盘后复盘');

    // UTC 02:05:09 恒对应北京时间 10:05:09（独立于宿主机时区）
    expect(formatClockTime(Date.parse('2026-11-25T02:05:09.000Z'))).toBe('10:05:09');
    expect(formatClockTime(Date.parse('2026-11-25T16:30:45.000Z'))).toBe('00:30:45');
    expect(formatClockTime(null)).toBe('—');
  });

  it('enforces A-share red-up/green-down/flat-neutral tones and marginal slope formatting', () => {
    expect(getSignedToneClass(0.01)).toBe('tone-up');
    expect(getSignedToneClass(-0.01)).toBe('tone-down');
    expect(getSignedToneClass(0)).toBe('');
    expect(getSignedToneClass(null)).toBe('');
    expect(getSignedToneClass(Number.NaN)).toBe('');

    expect(getSignedToneColor(1)).toBe('#ff7b72');
    expect(getSignedToneColor(-1)).toBe('#56d364');
    expect(getSignedToneColor(0)).toBe('#e6edf3');
    expect(getSignedToneColor(undefined)).toBe('#e6edf3');

    expect(formatPrice(3321.46)).toBe('3321.5');
    expect(formatPrice(18.526)).toBe('18.53');
    expect(formatPrice(0)).toBe('—');

    expect(formatSlopeTrend(0, 1.0)).toEqual({
      arrow: '→',
      label: '0.00%/分 · 1.00x',
      tone: 'flat',
    });
    expect(formatSlopeTrend(3.2, 1.6)).toEqual({
      arrow: '▲',
      label: '急放 +3.20%/分 · 1.60x',
      tone: 'surge',
    });
    expect(formatSlopeTrend(-3.2, 0.6)).toEqual({
      arrow: '▼',
      label: '急缩 -3.20%/分 · 0.60x',
      tone: 'shrink',
    });

    // 盘后/休市复盘态：保留尾盘斜率数值，去掉急放/急缩标签并降为中性灰样式
    expect(formatSlopeTrend(-17.45, 0.62, 3.0, -3.0, { postCloseReview: true })).toEqual({
      arrow: '',
      label: '尾盘 -17.45%/分 · 0.62x',
      tone: 'flat',
    });
    expect(formatSlopeTrend(5.5, 1.8, 3.0, -3.0, { postCloseReview: true })).toEqual({
      arrow: '',
      label: '尾盘 +5.50%/分 · 1.80x',
      tone: 'flat',
    });
  });
});
