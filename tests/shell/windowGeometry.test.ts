import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false, quit: vi.fn() },
  BrowserWindow: vi.fn(),
  screen: { getAllDisplays: vi.fn(() => []), getPrimaryDisplay: vi.fn() },
}));

import {
  BossVisibilityController,
  clampHudOpacity,
  computeDetailOverlayBounds,
  getDefaultHudPosition,
  isRectSufficientlyVisible,
  resolveHudBounds,
  type Rect,
} from '../../src/main/windows';

const PRIMARY_WORK_AREA: Rect = { x: 0, y: 0, width: 1920, height: 1040 };
const SECONDARY_WORK_AREA: Rect = { x: 1920, y: 0, width: 1920, height: 1040 };
const HUD_SIZE = { width: 376, height: 336 };
const DETAIL_SIZE = { width: 860, height: 580 };

describe('windowGeometry', () => {
  it('clamps HUD opacity to [0.3, 1.0] and falls back on non-finite input', () => {
    expect(clampHudOpacity(0.1)).toBe(0.3);
    expect(clampHudOpacity(0.3)).toBe(0.3);
    expect(clampHudOpacity(0.754)).toBe(0.75);
    expect(clampHudOpacity(1.5)).toBe(1.0);
    expect(clampHudOpacity(Number.NaN)).toBe(0.9);
    expect(clampHudOpacity(Number.POSITIVE_INFINITY)).toBe(0.9);
  });

  it('places default HUD inside primary workArea top-right without overlapping taskbar', () => {
    const pos = getDefaultHudPosition(HUD_SIZE, PRIMARY_WORK_AREA, 20);
    expect(pos.x).toBe(1920 - 376 - 20);
    expect(pos.y).toBe(20);
    expect(pos.y + HUD_SIZE.height).toBeLessThanOrEqual(PRIMARY_WORK_AREA.height);
  });

  it('restores saved HUD position when visible across multi-display setup', () => {
    const bounds = resolveHudBounds(
      { x: 2400, y: 120 },
      HUD_SIZE,
      [PRIMARY_WORK_AREA, SECONDARY_WORK_AREA],
      PRIMARY_WORK_AREA
    );
    expect(bounds).toEqual({ x: 2400, y: 120, ...HUD_SIZE });
  });

  it('recovers HUD into visible area when saved position is off-screen (disconnected monitor)', () => {
    const bounds = resolveHudBounds(
      { x: 2600, y: 180 },
      HUD_SIZE,
      [PRIMARY_WORK_AREA],
      PRIMARY_WORK_AREA
    );
    expect(isRectSufficientlyVisible(bounds, [PRIMARY_WORK_AREA])).toBe(true);
    expect(bounds.x).toBeGreaterThanOrEqual(PRIMARY_WORK_AREA.x);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(
      PRIMARY_WORK_AREA.x + PRIMARY_WORK_AREA.width
    );
    expect(bounds.y).toBeGreaterThanOrEqual(PRIMARY_WORK_AREA.y);
  });

  it('clamps partially off-screen HUD back into workArea', () => {
    const bounds = resolveHudBounds(
      { x: 1880, y: -120 },
      HUD_SIZE,
      [PRIMARY_WORK_AREA],
      PRIMARY_WORK_AREA
    );
    expect(bounds.x).toBe(PRIMARY_WORK_AREA.width - HUD_SIZE.width);
    expect(bounds.y).toBe(0);
    expect(isRectSufficientlyVisible(bounds, [PRIMARY_WORK_AREA])).toBe(true);
  });

  it('positions detail overlay adjacent to HUD (left first, then right) and centers when tight', () => {
    // HUD 在右上角 → 详情浮层优先贴近 HUD 左侧
    const hudRightTop: Rect = { x: 1524, y: 20, ...HUD_SIZE };
    const leftPlacement = computeDetailOverlayBounds(
      hudRightTop,
      DETAIL_SIZE,
      [PRIMARY_WORK_AREA],
      PRIMARY_WORK_AREA,
      12
    );
    expect(leftPlacement.x).toBe(1524 - 12 - DETAIL_SIZE.width);
    expect(leftPlacement.y).toBe(20);

    // HUD 在左上角 → 左侧不够，贴近右侧
    const hudLeftTop: Rect = { x: 20, y: 40, ...HUD_SIZE };
    const rightPlacement = computeDetailOverlayBounds(
      hudLeftTop,
      DETAIL_SIZE,
      [PRIMARY_WORK_AREA],
      PRIMARY_WORK_AREA,
      12
    );
    expect(rightPlacement.x).toBe(20 + HUD_SIZE.width + 12);
    expect(rightPlacement.y).toBe(40);

    // 较窄屏幕贴近四周均放不下 → 工作区居中
    const smallScreen: Rect = { x: 0, y: 0, width: 1024, height: 720 };
    const centeredHud: Rect = { x: 320, y: 200, ...HUD_SIZE };
    const centeredDetail = computeDetailOverlayBounds(
      centeredHud,
      DETAIL_SIZE,
      [smallScreen],
      smallScreen,
      12
    );
    expect(centeredDetail.x).toBe(Math.round((1024 - DETAIL_SIZE.width) / 2));
    expect(centeredDetail.y).toBe(Math.round((720 - DETAIL_SIZE.height) / 2));
  });
});

describe('BossVisibilityController', () => {
  it('hides all visible windows and restores exact pre-hide visibility state', () => {
    const controller = new BossVisibilityController();

    // 仅 HUD 可见 -> 隐藏 -> 恢复仅 HUD
    const hide1 = controller.computeNextVisibility({ hudVisible: true, detailVisible: false });
    expect(hide1).toEqual({
      action: 'hide',
      target: { hudVisible: false, detailVisible: false },
    });
    const restore1 = controller.computeNextVisibility({ hudVisible: false, detailVisible: false });
    expect(restore1).toEqual({
      action: 'restore',
      target: { hudVisible: true, detailVisible: false },
    });

    // HUD + Detail 同显 -> 隐藏 -> 恢复同显
    const hide2 = controller.computeNextVisibility({ hudVisible: true, detailVisible: true });
    expect(hide2).toEqual({
      action: 'hide',
      target: { hudVisible: false, detailVisible: false },
    });
    const restore2 = controller.computeNextVisibility({ hudVisible: false, detailVisible: false });
    expect(restore2).toEqual({
      action: 'restore',
      target: { hudVisible: true, detailVisible: true },
    });

    // 初始均隐藏且无历史快照 -> 至少恢复 HUD
    const restoreDefault = controller.computeNextVisibility({
      hudVisible: false,
      detailVisible: false,
    });
    expect(restoreDefault).toEqual({
      action: 'restore',
      target: { hudVisible: true, detailVisible: false },
    });
  });
});
