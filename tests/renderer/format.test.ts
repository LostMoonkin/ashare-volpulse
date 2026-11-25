import { describe, expect, it } from 'vitest';
import {
  formatClockTime,
  formatPhaseLabel,
  formatSignedPct,
  formatSignedTurnover,
  formatTurnover,
  formatVolumeState,
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
});
