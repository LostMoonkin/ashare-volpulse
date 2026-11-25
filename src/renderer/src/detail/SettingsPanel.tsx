import { useEffect, useState } from 'react';
import { ALLOWED_SLOPE_WINDOWS } from '../../../shared/constants';
import type {
  AlertMatchModeType,
  BossKeyStatus,
  DatabaseRetentionStats,
  DesktopShellState,
  MonitorConfig,
  ProviderHealthStatus,
  SecretStatus,
  SlopeWindowOption,
} from '../../../shared/types';

export interface SettingsPanelProps {
  shell: DesktopShellState | null;
  monitorConfig: MonitorConfig | null;
  bossKeyInput: string;
  bossKeyFeedback: BossKeyStatus | null;
  onBossKeyInputChange: (val: string) => void;
  onSaveBossKey: () => Promise<void>;
  onMonitorConfigUpdated: (next: MonitorConfig) => void;
}

function formatSecretSource(source: SecretStatus['source']): string {
  switch (source) {
    case 'safeStorage':
      return '软件内加密存储 (safeStorage)';
    case 'env':
      return '环境变量 (HITHINK_FINANCE_API_KEY)';
    case 'credentialsFile':
      return '本地凭据文件 (credentials.env)';
    default:
      return '未配置';
  }
}

export function SettingsPanel({
  shell,
  monitorConfig,
  bossKeyInput,
  bossKeyFeedback,
  onBossKeyInputChange,
  onSaveBossKey,
  onMonitorConfigUpdated,
}: SettingsPanelProps) {
  const [draft, setDraft] = useState<MonitorConfig | null>(monitorConfig);
  const [savingMonitor, setSavingMonitor] = useState(false);
  const [monitorSavedTip, setMonitorSavedTip] = useState<string | null>(null);

  const [secretStatus, setSecretStatus] = useState<SecretStatus | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyFeedback, setKeyFeedback] = useState<string | null>(null);
  const [healthResult, setHealthResult] = useState<ProviderHealthStatus | null>(null);

  const [retention, setRetention] = useState<DatabaseRetentionStats | null>(null);

  useEffect(() => {
    if (monitorConfig) setDraft(monitorConfig);
  }, [monitorConfig]);

  const loadStorageAndSecret = () => {
    void window.api.getSecretStatus().then(setSecretStatus).catch(() => {});
    void window.api.getDatabaseRetentionStats().then(setRetention).catch(() => {});
  };

  useEffect(() => {
    loadStorageAndSecret();
  }, []);

  const applyMonitorPatch = async (patch: Partial<MonitorConfig>) => {
    setSavingMonitor(true);
    setMonitorSavedTip(null);
    try {
      const updated = await window.api.updateMonitorConfig(patch);
      setDraft(updated);
      onMonitorConfigUpdated(updated);
      setMonitorSavedTip('已保存并实时生效');
      setTimeout(() => setMonitorSavedTip(null), 2200);
    } finally {
      setSavingMonitor(false);
    }
  };

  const handleSaveApiKey = async () => {
    const trimmed = apiKeyInput.trim();
    if (!trimmed) {
      setKeyFeedback('请输入有效的同花顺 API Key');
      return;
    }
    setKeyBusy(true);
    setKeyFeedback(null);
    setHealthResult(null);
    try {
      const nextStatus = await window.api.saveSecretApiKey(trimmed);
      setSecretStatus(nextStatus);
      // 立即清空明文输入框，绝不在界面留存明文
      setApiKeyInput('');
      setKeyFeedback('已通过系统 safeStorage 加密保存，明文已清空');
    } catch (err: unknown) {
      setKeyFeedback(`保存失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setKeyBusy(false);
    }
  };

  const handleClearApiKey = async () => {
    setKeyBusy(true);
    setKeyFeedback(null);
    setHealthResult(null);
    try {
      const nextStatus = await window.api.clearSecretApiKey();
      setSecretStatus(nextStatus);
      setKeyFeedback('已清除软件内加密保存的 API Key');
    } finally {
      setKeyBusy(false);
    }
  };

  const handleTestConnection = async () => {
    setKeyBusy(true);
    setHealthResult(null);
    setKeyFeedback(null);
    try {
      const res = await window.api.testHithinkConnection();
      setHealthResult(res);
    } finally {
      setKeyBusy(false);
    }
  };

  const opacityPct = Math.round((shell?.settings.hudOpacity ?? 0.9) * 100);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {/* 1. 行情轮询与放缩量/斜率告警参数 */}
      <section className="panel-card">
        <h2 className="panel-title">
          <span>监控频率、放缩量与斜率告警参数（即时生效并持久化）</span>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            {monitorSavedTip && <span className="badge badge-down">{monitorSavedTip}</span>}
            <button
              type="button"
              className="btn btn-accent"
              disabled={!draft || savingMonitor}
              onClick={() => draft && void applyMonitorPatch(draft)}
            >
              {savingMonitor ? '应用中…' : '保存并立即生效'}
            </button>
          </div>
        </h2>

        {draft && (
          <div className="settings-grid">
            <div className="setting-row">
              <div>
                <div>盘中快照刷新周期（{draft.pollingIntervalSec} 秒）</div>
                <div className="setting-desc">支持 3–15 秒；异常或限流时自动触发退避降频</div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input
                  type="range"
                  min={3}
                  max={15}
                  step={1}
                  value={draft.pollingIntervalSec}
                  onChange={(e) =>
                    setDraft({ ...draft, pollingIntervalSec: Number(e.target.value) })
                  }
                />
                <span className="muted-mono" style={{ width: '32px', textAlign: 'right' }}>
                  {draft.pollingIntervalSec}s
                </span>
              </div>
            </div>

            <div className="setting-row">
              <div>
                <div>放量 / 缩量判定阈值（同比昨日同期）</div>
                <div className="setting-desc">默认 ≥ +5% 判放量、≤ -5% 判缩量，其余为平量</div>
              </div>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <label className="inline-num">
                  <span>放量 ≥</span>
                  <input
                    type="number"
                    step="0.5"
                    className="num-input"
                    value={draft.expandThresholdPct}
                    onChange={(e) =>
                      setDraft({ ...draft, expandThresholdPct: Number(e.target.value) })
                    }
                  />
                  <span>%</span>
                </label>
                <label className="inline-num">
                  <span>缩量 ≤</span>
                  <input
                    type="number"
                    step="0.5"
                    className="num-input"
                    value={draft.shrinkThresholdPct}
                    onChange={(e) =>
                      setDraft({ ...draft, shrinkThresholdPct: Number(e.target.value) })
                    }
                  />
                  <span>%</span>
                </label>
              </div>
            </div>

            <div className="setting-row">
              <div>
                <div>滚动斜率窗口长度</div>
                <div className="setting-desc">作用于 OLS 斜率曲线与区间增量倍数（折叠午休后连续计算）</div>
              </div>
              <div className="segmented-group">
                {ALLOWED_SLOPE_WINDOWS.map((w) => (
                  <button
                    key={w}
                    type="button"
                    className={`seg-btn ${draft.slopeWindow === w ? 'active' : ''}`}
                    onClick={() => setDraft({ ...draft, slopeWindow: w as SlopeWindowOption })}
                  >
                    {w} 分钟
                  </button>
                ))}
              </div>
            </div>

            <div className="setting-row">
              <div>
                <div>快速放量（急放）触发阈值</div>
                <div className="setting-desc">默认边际量比斜率 ≥ +3.0%/分，区间增量倍数 ≥ 1.5x</div>
              </div>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <label className="inline-num">
                  <span>斜率 ≥</span>
                  <input
                    type="number"
                    step="0.1"
                    className="num-input"
                    value={draft.surgeSlopeThreshold}
                    onChange={(e) =>
                      setDraft({ ...draft, surgeSlopeThreshold: Number(e.target.value) })
                    }
                  />
                  <span>%/分</span>
                </label>
                <label className="inline-num">
                  <span>倍数 ≥</span>
                  <input
                    type="number"
                    step="0.05"
                    className="num-input"
                    value={draft.surgeMultipleThreshold}
                    onChange={(e) =>
                      setDraft({ ...draft, surgeMultipleThreshold: Number(e.target.value) })
                    }
                  />
                  <span>x</span>
                </label>
              </div>
            </div>

            <div className="setting-row">
              <div>
                <div>快速缩量（急缩）触发阈值</div>
                <div className="setting-desc">默认边际量比斜率 ≤ -3.0%/分，区间增量倍数 ≤ 0.65x</div>
              </div>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <label className="inline-num">
                  <span>斜率 ≤</span>
                  <input
                    type="number"
                    step="0.1"
                    className="num-input"
                    value={draft.shrinkSlopeThreshold}
                    onChange={(e) =>
                      setDraft({ ...draft, shrinkSlopeThreshold: Number(e.target.value) })
                    }
                  />
                  <span>%/分</span>
                </label>
                <label className="inline-num">
                  <span>倍数 ≤</span>
                  <input
                    type="number"
                    step="0.05"
                    className="num-input"
                    value={draft.shrinkMultipleThreshold}
                    onChange={(e) =>
                      setDraft({ ...draft, shrinkMultipleThreshold: Number(e.target.value) })
                    }
                  />
                  <span>x</span>
                </label>
              </div>
            </div>

            <div className="setting-row">
              <div>
                <div>双指标组合模式、冷却时长与告警总开关</div>
                <div className="setting-desc">同标的同方向触发后在冷却期内不重复弹窗与发声</div>
              </div>
              <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
                <div className="segmented-group">
                  {(['AND', 'OR'] as AlertMatchModeType[]).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      className={`seg-btn ${draft.matchMode === mode ? 'active' : ''}`}
                      onClick={() => setDraft({ ...draft, matchMode: mode })}
                    >
                      {mode === 'AND' ? '且 (AND)' : '或 (OR)'}
                    </button>
                  ))}
                </div>
                <label className="inline-num">
                  <span>冷却</span>
                  <input
                    type="number"
                    min={1}
                    max={120}
                    step={1}
                    className="num-input"
                    value={draft.cooldownMinutes}
                    onChange={(e) =>
                      setDraft({ ...draft, cooldownMinutes: Number(e.target.value) })
                    }
                  />
                  <span>分</span>
                </label>
                <label className="inline-check">
                  <input
                    type="checkbox"
                    checked={draft.alertsEnabled}
                    onChange={(e) => setDraft({ ...draft, alertsEnabled: e.target.checked })}
                  />
                  <span>启用全局告警</span>
                </label>
              </div>
            </div>
          </div>
        )}
      </section>

      {/* 2. 同花顺 Fuyao API Key 安全管理 */}
      <section className="panel-card">
        <h2 className="panel-title">
          <span>同花顺 Fuyao API Key（加密落盘，永不回显明文）</span>
          <span className={`badge ${secretStatus?.configured ? 'badge-down' : 'badge-muted'}`}>
            {secretStatus?.configured ? '已配置' : '未配置'}
          </span>
        </h2>

        <div className="settings-grid">
          <div className="setting-row">
            <div>
              <div>当前凭据来源：{secretStatus ? formatSecretSource(secretStatus.source) : '读取中…'}</div>
              <div className="setting-desc">
                读取优先级：safeStorage 本地加密 → HITHINK_FINANCE_API_KEY → credentials.env
              </div>
            </div>
            <div style={{ display: 'flex', gap: '6px' }}>
              <button
                type="button"
                className="btn"
                disabled={keyBusy}
                onClick={() => void handleTestConnection()}
              >
                {keyBusy ? '测试中…' : '连接测试'}
              </button>
              {secretStatus?.source === 'safeStorage' && (
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={keyBusy}
                  onClick={() => void handleClearApiKey()}
                >
                  清除已存 Key
                </button>
              )}
            </div>
          </div>

          <div className="setting-row">
            <div style={{ flex: 1 }}>
              <div>更新 / 保存 API Key</div>
              <div className="setting-desc">
                {secretStatus?.encryptionAvailable === false
                  ? '当前系统 safeStorage 不可用，请改用环境变量配置'
                  : '保存后使用 Windows DPAPI 加密写入本地文件，界面不回显'}
              </div>
            </div>
            <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
              <input
                type="password"
                autoComplete="off"
                className="text-input"
                style={{ width: '210px' }}
                value={apiKeyInput}
                onChange={(e) => setApiKeyInput(e.target.value)}
                placeholder="输入新同花顺 API Key"
              />
              <button
                type="button"
                className="btn btn-accent"
                disabled={keyBusy || secretStatus?.encryptionAvailable === false}
                onClick={() => void handleSaveApiKey()}
              >
                加密保存
              </button>
            </div>
          </div>

          {keyFeedback && (
            <div style={{ fontSize: '12px', color: '#79c0ff' }}>{keyFeedback}</div>
          )}

          {healthResult && (
            <div
              style={{
                fontSize: '12px',
                color: healthResult.ok ? '#56d364' : '#ff7b72',
              }}
            >
              {healthResult.ok
                ? `✓ 连接测试成功（延迟 ${healthResult.latencyMs}ms）`
                : `✕ 连接测试失败：${healthResult.error ?? '未知错误'}`}
            </div>
          )}
        </div>
      </section>

      {/* 3. 桌面外壳与老板键 */}
      <section className="panel-card">
        <h2 className="panel-title">
          <span>桌面外壳、提示音与全局老板键</span>
        </h2>
        <div className="settings-grid">
          <div className="setting-row">
            <div>
              <div>HUD 窗口透明度（{opacityPct}%）</div>
              <div className="setting-desc">支持 30%–100%，重启后自动恢复</div>
            </div>
            <input
              type="range"
              min={30}
              max={100}
              step={5}
              value={opacityPct}
              onChange={(e) => void window.api.setHudOpacity(Number(e.target.value) / 100)}
            />
          </div>

          <div className="setting-row">
            <div>
              <div>窗口行为与提示音</div>
              <div className="setting-desc">静音仅关闭提示音，写库、通知与呼吸高亮照常</div>
            </div>
            <div style={{ display: 'flex', gap: '14px', alignItems: 'center' }}>
              <label className="inline-check">
                <input
                  type="checkbox"
                  checked={shell?.settings.alwaysOnTop ?? true}
                  onChange={(e) => void window.api.setAlwaysOnTop(e.target.checked)}
                />
                <span>始终置顶</span>
              </label>
              <label className="inline-check">
                <input
                  type="checkbox"
                  checked={shell?.settings.muted ?? false}
                  onChange={(e) => void window.api.setMuted(e.target.checked)}
                />
                <span>静音提醒</span>
              </label>
              <label className="inline-check">
                <input
                  type="checkbox"
                  checked={shell?.settings.autoLaunch ?? false}
                  onChange={(e) => void window.api.setAutoLaunch(e.target.checked)}
                />
                <span>开机自启</span>
              </label>
            </div>
          </div>

          <div className="setting-row">
            <div>
              <div>全局老板键（一键隐藏 / 恢复所有窗口）</div>
              <div
                className="setting-desc"
                style={{
                  color: bossKeyFeedback?.conflictMessage ? '#f0c050' : undefined,
                }}
              >
                {bossKeyFeedback?.conflictMessage
                  ? `⚠ ${bossKeyFeedback.conflictMessage}`
                  : bossKeyFeedback?.registered
                    ? `已生效：${bossKeyFeedback.accelerator}`
                    : '未注册'}
              </div>
            </div>
            <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
              <input
                type="text"
                className="text-input"
                value={bossKeyInput}
                onChange={(e) => onBossKeyInputChange(e.target.value)}
                placeholder="例如 Alt+Shift+A"
              />
              <button type="button" className="btn" onClick={() => void onSaveBossKey()}>
                应用改绑
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* 4. 本地 SQLite 30 交易日留存统计 */}
      <section className="panel-card">
        <h2 className="panel-title">
          <span>本地 SQLite 留存统计（自动滚动保留近 30 个交易日）</span>
          <button type="button" className="btn btn-sm" onClick={loadStorageAndSecret}>
            刷新统计
          </button>
        </h2>
        {retention ? (
          <div className="retention-grid">
            <div className="metric-item">
              <div className="metric-label">缓存交易日历</div>
              <div className="metric-value">{retention.tradingDaysCount} 天</div>
            </div>
            <div className="metric-item">
              <div className="metric-label">1 分钟分时记录</div>
              <div className="metric-value">{retention.intradayBarsCount.toLocaleString('zh-CN')}</div>
            </div>
            <div className="metric-item">
              <div className="metric-label">分时覆盖交易日</div>
              <div className="metric-value">{retention.distinctBarDatesCount} 天</div>
            </div>
            <div className="metric-item">
              <div className="metric-label">竞价快照 / 告警 / 自选</div>
              <div className="metric-value" style={{ fontSize: '13px' }}>
                {retention.auctionSnapshotsCount} / {retention.alertEventsCount} /{' '}
                {retention.watchlistCount}
              </div>
            </div>
          </div>
        ) : (
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>正在读取统计…</div>
        )}
      </section>
    </div>
  );
}
