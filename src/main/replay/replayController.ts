import { getPrevTradingDate } from '../../core';
import {
  DEFAULT_REPLAY_SPEED,
  REPLAY_BASE_STEP_MS,
  REPLAY_SPEED_MULTIPLIERS,
  type ReplaySpeedMultiplier,
} from '../../shared/constants';
import type {
  AlertDispatchPayload,
  MonitorConfig,
  ReplayAvailableDateInfo,
  ReplayMonitorParams,
  ReplaySessionState,
  ReplayTriggerReason,
} from '../../shared/types';
import type { AppDatabase } from '../storage/database';
import { sanitizeMonitorConfig } from '../storage/monitorSettingsStore';
import { DayReplayEngine, type ReplayStepResult } from './dayReplayEngine';

export interface ReplayTimerApi {
  setInterval: (cb: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval: (id: ReturnType<typeof setInterval>) => void;
}

export interface InteractiveReplayControllerOptions {
  database: AppDatabase;
  getLiveMonitorConfig: () => MonitorConfig;
  onStateUpdate?: (state: ReplaySessionState) => void;
  timerApi?: ReplayTimerApi;
}

const DEFAULT_TIMER_API: ReplayTimerApi = {
  setInterval: (cb, ms) => setInterval(cb, ms),
  clearInterval: (id) => clearInterval(id),
};

export function extractReplayParams(config: MonitorConfig): ReplayMonitorParams {
  return {
    expandThresholdPct: config.expandThresholdPct,
    shrinkThresholdPct: config.shrinkThresholdPct,
    slopeWindow: config.slopeWindow,
    alertsEnabled: config.alertsEnabled,
    surgeSlopeThreshold: config.surgeSlopeThreshold,
    surgeMultipleThreshold: config.surgeMultipleThreshold,
    shrinkSlopeThreshold: config.shrinkSlopeThreshold,
    shrinkMultipleThreshold: config.shrinkMultipleThreshold,
    matchMode: config.matchMode,
    cooldownMinutes: config.cooldownMinutes,
  };
}

export function areReplayParamsEqual(a: ReplayMonitorParams, b: ReplayMonitorParams): boolean {
  return (
    a.expandThresholdPct === b.expandThresholdPct &&
    a.shrinkThresholdPct === b.shrinkThresholdPct &&
    a.slopeWindow === b.slopeWindow &&
    a.alertsEnabled === b.alertsEnabled &&
    a.surgeSlopeThreshold === b.surgeSlopeThreshold &&
    a.surgeMultipleThreshold === b.surgeMultipleThreshold &&
    a.shrinkSlopeThreshold === b.shrinkSlopeThreshold &&
    a.shrinkMultipleThreshold === b.shrinkMultipleThreshold &&
    a.matchMode === b.matchMode &&
    a.cooldownMinutes === b.cooldownMinutes
  );
}

export function normalizeReplaySpeed(raw: unknown, fallback: ReplaySpeedMultiplier): ReplaySpeedMultiplier {
  if (
    typeof raw === 'number' &&
    (REPLAY_SPEED_MULTIPLIERS as readonly number[]).includes(raw)
  ) {
    return raw as ReplaySpeedMultiplier;
  }
  return fallback;
}

export function computeReplayStepIntervalMs(speed: ReplaySpeedMultiplier): number {
  return Math.max(15, Math.round(REPLAY_BASE_STEP_MS / speed));
}

function sanitizeReplayParams(
  patch: Partial<ReplayMonitorParams>,
  base: ReplayMonitorParams,
  liveConfig: MonitorConfig
): ReplayMonitorParams {
  const merged = sanitizeMonitorConfig(
    {
      ...liveConfig,
      ...base,
      ...patch,
    },
    liveConfig
  );
  return extractReplayParams(merged);
}

/**
 * 独立交互式复盘回放会话控制器：
 * - 完全独立于实盘 PollingScheduler 与 AlertDispatcher 运行
 * - 一次性预计算 09:25 → 15:00 全天 241 帧快照与累计告警，保证任意 Seek / 单步 100% 确定性一致
 * - 回放告警严格仅存内存并带有 [回放] 标记，绝不写入 alert_events 或弹系统通知
 */
export class InteractiveReplayController {
  private readonly db: AppDatabase;
  private readonly getLiveMonitorConfig: () => MonitorConfig;
  private readonly onStateUpdate?: (state: ReplaySessionState) => void;
  private readonly timerApi: ReplayTimerApi;

  private loadedTradeDate: string | null = null;
  private loadedPrevTradeDate: string | null = null;
  private customParams: ReplayMonitorParams | null = null;
  private speed: ReplaySpeedMultiplier = DEFAULT_REPLAY_SPEED;
  private playing = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private currentStepIndex = 0;
  private cachedFrames: ReplayStepResult[] = [];
  private cumulativeAlertsByStep: AlertDispatchPayload[][] = [];
  private alertCountBySymbolByStep: Array<Record<string, number>> = [];
  private totalDayAlertCount = 0;
  private lastError: string | null = null;

  constructor(options: InteractiveReplayControllerOptions) {
    this.db = options.database;
    this.getLiveMonitorConfig = options.getLiveMonitorConfig;
    this.onStateUpdate = options.onStateUpdate;
    this.timerApi = options.timerApi ?? DEFAULT_TIMER_API;
  }

  getAvailableDates(): ReplayAvailableDateInfo[] {
    const summaries = this.db.getRecordedDateSummaries();
    const summaryMap = new Map(summaries.map((s) => [s.tradeDate, s]));
    const dateList = summaries.map((s) => s.tradeDate);
    const openDays = new Set(this.db.getTradingDays(true).map((d) => d.date));

    return summaries.map((s) => {
      let prevTradeDate = getPrevTradingDate(s.tradeDate, openDays);
      if (!prevTradeDate) {
        prevTradeDate = dateList.find((d) => d < s.tradeDate) ?? null;
      }
      const prevSummary = prevTradeDate ? summaryMap.get(prevTradeDate) : undefined;
      const hasPrevBaseline = Boolean(
        prevSummary && prevSummary.shBarCount > 0 && prevSummary.szBarCount > 0
      );
      return {
        tradeDate: s.tradeDate,
        prevTradeDate,
        hasPrevBaseline,
        shBarCount: s.shBarCount,
        szBarCount: s.szBarCount,
      };
    });
  }

  getEffectiveParams(): ReplayMonitorParams {
    const liveParams = extractReplayParams(this.getLiveMonitorConfig());
    return this.customParams ? { ...this.customParams } : liveParams;
  }

  getState(): ReplaySessionState {
    return this.buildSessionState('init', []);
  }

  loadDate(requestedDate?: string | null): ReplaySessionState {
    this.stopTimer();
    this.playing = false;

    const availableDates = this.getAvailableDates();
    if (availableDates.length === 0) {
      this.loadedTradeDate = null;
      this.loadedPrevTradeDate = null;
      this.cachedFrames = [];
      this.cumulativeAlertsByStep = [];
      this.alertCountBySymbolByStep = [];
      this.totalDayAlertCount = 0;
      this.currentStepIndex = 0;
      this.lastError =
        '本地 SQLite 暂无已录制分钟数据，请先正常运行应用并完成一次行情分时补齐后再进行复盘回放。';
      return this.emitState('load', [], availableDates);
    }

    const trimmed = requestedDate?.trim() || null;
    if (trimmed && !availableDates.some((d) => d.tradeDate === trimmed)) {
      this.loadedTradeDate = null;
      this.loadedPrevTradeDate = null;
      this.cachedFrames = [];
      this.cumulativeAlertsByStep = [];
      this.alertCountBySymbolByStep = [];
      this.totalDayAlertCount = 0;
      this.currentStepIndex = 0;
      this.lastError = `本地 SQLite 未找到交易日 ${trimmed} 的分钟录制数据。`;
      return this.emitState('load', [], availableDates);
    }

    const targetDate =
      trimmed ??
      availableDates.find((d) => d.hasPrevBaseline)?.tradeDate ??
      availableDates[0].tradeDate;

    try {
      const liveConfig = this.getLiveMonitorConfig();
      const effectiveParams = this.getEffectiveParams();
      this.recomputeFrames(targetDate, effectiveParams, liveConfig);
      this.currentStepIndex = Math.max(0, this.cachedFrames.length - 1);
      this.lastError = null;
    } catch (err: unknown) {
      this.loadedTradeDate = null;
      this.loadedPrevTradeDate = null;
      this.cachedFrames = [];
      this.cumulativeAlertsByStep = [];
      this.alertCountBySymbolByStep = [];
      this.totalDayAlertCount = 0;
      this.currentStepIndex = 0;
      this.lastError = err instanceof Error ? err.message : String(err);
    }

    return this.emitState('load', [], availableDates);
  }

  play(): ReplaySessionState {
    if (this.cachedFrames.length === 0) {
      const loaded = this.loadDate();
      if (this.cachedFrames.length === 0) {
        return loaded;
      }
    }

    if (this.currentStepIndex >= this.cachedFrames.length - 1) {
      this.currentStepIndex = 0;
    }

    this.stopTimer();
    this.playing = true;
    this.startTimer();
    return this.emitState('play', []);
  }

  pause(): ReplaySessionState {
    const wasPlaying = this.playing;
    this.stopTimer();
    this.playing = false;
    if (!wasPlaying) {
      return this.buildSessionState('seek', []);
    }
    return this.emitState('seek', []);
  }

  restart(): ReplaySessionState {
    if (this.cachedFrames.length === 0) {
      const loaded = this.loadDate();
      if (this.cachedFrames.length === 0) {
        return loaded;
      }
    }

    this.stopTimer();
    this.currentStepIndex = 0;
    this.playing = true;
    this.startTimer();
    return this.emitState('play', []);
  }

  seek(targetStepIndex: number): ReplaySessionState {
    this.stopTimer();
    this.playing = false;

    if (this.cachedFrames.length === 0) {
      return this.buildSessionState('seek', []);
    }

    if (typeof targetStepIndex === 'number' && Number.isFinite(targetStepIndex)) {
      this.currentStepIndex = Math.max(
        0,
        Math.min(this.cachedFrames.length - 1, Math.round(targetStepIndex))
      );
    }

    return this.emitState('seek', []);
  }

  step(delta: number): ReplaySessionState {
    this.stopTimer();
    this.playing = false;

    if (this.cachedFrames.length === 0) {
      return this.buildSessionState('step', []);
    }

    const offset = typeof delta === 'number' && Number.isFinite(delta) ? Math.trunc(delta) : 0;
    this.currentStepIndex = Math.max(
      0,
      Math.min(this.cachedFrames.length - 1, this.currentStepIndex + offset)
    );

    return this.emitState('step', []);
  }

  setSpeed(speed: ReplaySpeedMultiplier): ReplaySessionState {
    const nextSpeed = normalizeReplaySpeed(speed, this.speed);
    this.speed = nextSpeed;
    if (this.playing) {
      this.stopTimer();
      this.startTimer();
    }
    return this.emitState('seek', []);
  }

  updateParams(patch: Partial<ReplayMonitorParams>): ReplaySessionState {
    this.stopTimer();
    this.playing = false;

    const liveConfig = this.getLiveMonitorConfig();
    const liveParams = extractReplayParams(liveConfig);
    const nextParams = sanitizeReplayParams(patch, this.getEffectiveParams(), liveConfig);
    this.customParams = areReplayParamsEqual(nextParams, liveParams) ? null : nextParams;

    if (this.loadedTradeDate) {
      this.safeRecomputeCurrentDate(this.loadedTradeDate, nextParams, liveConfig);
    }

    return this.emitState('recompute', []);
  }

  resetParams(): ReplaySessionState {
    this.stopTimer();
    this.playing = false;
    this.customParams = null;

    const liveConfig = this.getLiveMonitorConfig();
    const liveParams = extractReplayParams(liveConfig);
    if (this.loadedTradeDate) {
      this.safeRecomputeCurrentDate(this.loadedTradeDate, liveParams, liveConfig);
    }

    return this.emitState('recompute', []);
  }

  markAppliedToLive(nextLiveConfig: MonitorConfig): ReplaySessionState {
    this.stopTimer();
    this.playing = false;
    this.customParams = null;

    const liveParams = extractReplayParams(nextLiveConfig);
    if (this.loadedTradeDate) {
      this.safeRecomputeCurrentDate(this.loadedTradeDate, liveParams, nextLiveConfig);
    }

    return this.emitState('recompute', []);
  }

  syncLiveMonitorConfig(nextLiveConfig: MonitorConfig): void {
    if (!this.loadedTradeDate) return;
    const effectiveParams = this.customParams ?? extractReplayParams(nextLiveConfig);
    if (this.customParams && areReplayParamsEqual(this.customParams, extractReplayParams(nextLiveConfig))) {
      this.customParams = null;
    }
    this.safeRecomputeCurrentDate(this.loadedTradeDate, effectiveParams, nextLiveConfig);
    this.emitState('recompute', []);
  }

  syncWatchlistChanged(): void {
    if (!this.loadedTradeDate) return;
    const liveConfig = this.getLiveMonitorConfig();
    const effectiveParams = this.getEffectiveParams();
    this.safeRecomputeCurrentDate(this.loadedTradeDate, effectiveParams, liveConfig);
    this.emitState('recompute', []);
  }

  dispose(): void {
    this.stopTimer();
    this.playing = false;
  }

  private safeRecomputeCurrentDate(
    tradeDate: string,
    params: ReplayMonitorParams,
    liveConfig: MonitorConfig
  ): void {
    try {
      this.recomputeFrames(tradeDate, params, liveConfig);
      this.currentStepIndex = Math.max(
        0,
        Math.min(Math.max(0, this.cachedFrames.length - 1), this.currentStepIndex)
      );
      this.lastError = null;
    } catch (err: unknown) {
      this.stopTimer();
      this.playing = false;
      this.loadedTradeDate = null;
      this.loadedPrevTradeDate = null;
      this.cachedFrames = [];
      this.cumulativeAlertsByStep = [];
      this.alertCountBySymbolByStep = [];
      this.totalDayAlertCount = 0;
      this.currentStepIndex = 0;
      this.lastError = err instanceof Error ? err.message : String(err);
    }
  }

  private recomputeFrames(
    tradeDate: string,
    params: ReplayMonitorParams,
    liveConfig: MonitorConfig
  ): void {
    const engine = new DayReplayEngine({
      database: this.db,
      tradeDate,
      stepIntervalMs: computeReplayStepIntervalMs(this.speed),
      enabledCoreIndices: liveConfig.enabledCoreIndices,
      enabledOptionalIndices: liveConfig.enabledOptionalIndices,
      energyConfig: {
        expandThresholdPct: params.expandThresholdPct,
        shrinkThresholdPct: params.shrinkThresholdPct,
        slopeWindow: params.slopeWindow,
      },
      alertConfig: {
        enabled: params.alertsEnabled,
        surgeSlopeThreshold: params.surgeSlopeThreshold,
        surgeMultipleThreshold: params.surgeMultipleThreshold,
        shrinkSlopeThreshold: params.shrinkSlopeThreshold,
        shrinkMultipleThreshold: params.shrinkMultipleThreshold,
        matchMode: params.matchMode,
        cooldownMinutes: params.cooldownMinutes,
        slopeWindow: params.slopeWindow,
      },
    });

    const frames = engine.computeAllFrames();
    const cumulativeAlertsByStep: AlertDispatchPayload[][] = [];
    const alertCountBySymbolByStep: Array<Record<string, number>> = [];
    let runningAlerts: AlertDispatchPayload[] = [];
    const runningCounts: Record<string, number> = {};
    let totalCount = 0;

    for (const frame of frames) {
      if (frame.triggeredAlerts.length > 0) {
        const reversed = [...frame.triggeredAlerts].reverse();
        runningAlerts = [...reversed, ...runningAlerts];
        for (const ev of frame.triggeredAlerts) {
          totalCount += 1;
          runningCounts[ev.symbol] = (runningCounts[ev.symbol] ?? 0) + 1;
        }
      }
      cumulativeAlertsByStep.push(runningAlerts);
      alertCountBySymbolByStep.push({ ...runningCounts });
    }

    this.loadedTradeDate = engine.getTradeDate();
    this.loadedPrevTradeDate = engine.getPrevTradeDate();
    this.cachedFrames = frames;
    this.cumulativeAlertsByStep = cumulativeAlertsByStep;
    this.alertCountBySymbolByStep = alertCountBySymbolByStep;
    this.totalDayAlertCount = totalCount;
  }

  private startTimer(): void {
    const interval = computeReplayStepIntervalMs(this.speed);
    this.timer = this.timerApi.setInterval(() => {
      if (!this.playing) {
        this.stopTimer();
        return;
      }
      const nextIndex = this.currentStepIndex + 1;
      if (nextIndex >= this.cachedFrames.length) {
        this.stopTimer();
        this.playing = false;
        this.emitState('play', []);
        return;
      }

      this.currentStepIndex = nextIndex;
      const frame = this.cachedFrames[nextIndex];
      if (nextIndex >= this.cachedFrames.length - 1) {
        this.stopTimer();
        this.playing = false;
      }
      this.emitState('play', frame.triggeredAlerts);
    }, interval);
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      this.timerApi.clearInterval(this.timer);
      this.timer = null;
    }
  }

  private buildSessionState(
    triggerReason: ReplayTriggerReason,
    newlyTriggeredAlerts: AlertDispatchPayload[],
    preloadedDates?: ReplayAvailableDateInfo[]
  ): ReplaySessionState {
    const availableDates = preloadedDates ?? this.getAvailableDates();
    const liveParams = extractReplayParams(this.getLiveMonitorConfig());
    const params = this.customParams ? { ...this.customParams } : liveParams;
    const isCustomParams = this.customParams !== null && !areReplayParamsEqual(this.customParams, liveParams);
    const stepIntervalMs = computeReplayStepIntervalMs(this.speed);

    const frame =
      this.cachedFrames.length > 0
        ? this.cachedFrames[Math.max(0, Math.min(this.cachedFrames.length - 1, this.currentStepIndex))]
        : null;
    const totalSteps = this.cachedFrames.length;
    const stepIndex = frame ? frame.stepIndex : 0;

    return {
      availableDates,
      tradeDate: this.loadedTradeDate,
      prevTradeDate: this.loadedPrevTradeDate,
      stepIndex,
      totalSteps,
      currentTimeLabel: frame ? frame.timeLabel : '--:--',
      playing: this.playing,
      speed: this.speed,
      stepIntervalMs,
      finished: totalSteps > 0 && stepIndex >= totalSteps - 1,
      triggerReason,
      params,
      isCustomParams,
      marketState: frame ? frame.state : null,
      alerts: this.cumulativeAlertsByStep[stepIndex] ?? [],
      newlyTriggeredAlerts: [...newlyTriggeredAlerts],
      totalDayAlertCount: this.totalDayAlertCount,
      alertCountBySymbol: this.alertCountBySymbolByStep[stepIndex] ?? {},
      error: this.lastError,
    };
  }

  private emitState(
    triggerReason: ReplayTriggerReason,
    newlyTriggeredAlerts: AlertDispatchPayload[],
    preloadedDates?: ReplayAvailableDateInfo[]
  ): ReplaySessionState {
    const state = this.buildSessionState(triggerReason, newlyTriggeredAlerts, preloadedDates);
    this.onStateUpdate?.(state);
    return state;
  }
}
