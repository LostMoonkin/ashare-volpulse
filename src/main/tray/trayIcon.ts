import zlib from 'node:zlib';
import { nativeImage, type NativeImage } from 'electron';
import type { MarketDashboardState } from '../../shared/types';

export type TrayIconMood = 'expanding' | 'shrinking' | 'flat' | 'degraded';

interface RgbaColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

const MOOD_COLORS: Record<TrayIconMood, { primary: RgbaColor; accent: RgbaColor }> = {
  // 红涨绿跌：放量用红色，缩量用绿色，平量用冷灰蓝，降级用琥珀橙
  expanding: {
    primary: { r: 248, g: 81, b: 73, a: 255 },
    accent: { r: 255, g: 138, b: 128, a: 255 },
  },
  shrinking: {
    primary: { r: 46, g: 160, b: 67, a: 255 },
    accent: { r: 103, g: 214, b: 122, a: 255 },
  },
  flat: {
    primary: { r: 88, g: 166, b: 255, a: 255 },
    accent: { r: 147, g: 197, b: 253, a: 255 },
  },
  degraded: {
    primary: { r: 210, g: 153, b: 34, a: 255 },
    accent: { r: 245, g: 197, b: 86, a: 255 },
  },
};

const BG_COLOR: RgbaColor = { r: 18, g: 24, b: 34, a: 255 };
const BORDER_COLOR: RgbaColor = { r: 56, g: 68, b: 84, a: 255 };

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makePngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodeRgbaToPng(width: number, height: number, rgba: Uint8Array): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter type 0 (None)
    const srcStart = y * stride;
    raw.set(rgba.subarray(srcStart, srcStart + stride), rowStart + 1);
  }

  const compressed = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    signature,
    makePngChunk('IHDR', ihdr),
    makePngChunk('IDAT', compressed),
    makePngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function setPixel(rgba: Uint8Array, size: number, x: number, y: number, color: RgbaColor): void {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const idx = (y * size + x) * 4;
  rgba[idx] = color.r;
  rgba[idx + 1] = color.g;
  rgba[idx + 2] = color.b;
  rgba[idx + 3] = color.a;
}

/**
 * 纯代码生成 32x32 暗底圆角能量柱 PNG（无外部图片依赖，跨 DPI 清晰显示）。
 */
export function generateTrayIconPng(mood: TrayIconMood): Buffer {
  const size = 32;
  const rgba = new Uint8Array(size * size * 4);
  const { primary, accent } = MOOD_COLORS[mood];

  const radius = 6;
  const isInsideRoundedRect = (x: number, y: number, inset: number): boolean => {
    const min = inset;
    const max = size - 1 - inset;
    if (x < min || x > max || y < min || y > max) return false;
    const r = Math.max(1, radius - inset);
    const dx = x < min + r ? min + r - x : x > max - r ? x - (max - r) : 0;
    const dy = y < min + r ? min + r - y : y > max - r ? y - (max - r) : 0;
    return dx * dx + dy * dy <= r * r;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (isInsideRoundedRect(x, y, 2)) {
        setPixel(rgba, size, x, y, BG_COLOR);
      } else if (isInsideRoundedRect(x, y, 1)) {
        setPixel(rgba, size, x, y, BORDER_COLOR);
      }
    }
  }

  // 绘制三根渐高能量柱（表示盘中量能脉冲）
  const bars: Array<{ x0: number; x1: number; topY: number; color: RgbaColor }> = [
    { x0: 6, x1: 11, topY: 17, color: primary },
    { x0: 13, x1: 18, topY: 12, color: primary },
    { x0: 20, x1: 25, topY: 7, color: accent },
  ];
  const bottomY = 25;

  for (const bar of bars) {
    for (let y = bar.topY; y <= bottomY; y++) {
      for (let x = bar.x0; x <= bar.x1; x++) {
        setPixel(rgba, size, x, y, bar.color);
      }
    }
  }

  return encodeRgbaToPng(size, size, rgba);
}

export function resolveTrayIconMood(state: MarketDashboardState | null): TrayIconMood {
  if (!state) return 'flat';
  if (state.status.degraded || state.status.stale || state.marketTotal.degraded) {
    return 'degraded';
  }
  const volumeState = state.marketTotal.metrics?.volumeState;
  if (volumeState === 'EXPANDING') return 'expanding';
  if (volumeState === 'SHRINKING') return 'shrinking';
  return 'flat';
}

const iconCache = new Map<TrayIconMood, NativeImage>();

export function getTrayNativeImage(mood: TrayIconMood): NativeImage {
  const cached = iconCache.get(mood);
  if (cached) return cached;
  const png = generateTrayIconPng(mood);
  const img = nativeImage.createFromBuffer(png).resize({ width: 16, height: 16 });
  iconCache.set(mood, img);
  return img;
}
