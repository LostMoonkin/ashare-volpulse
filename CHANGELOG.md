# Changelog

本文件记录 `ashare-volpulse` 的主要变更历史。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.1.7] - 2026-11-28

### Added
- 新增独立「复盘回放」控制台（详情浮层独立页签），与后台实盘轮询、HUD 实时看板及实盘告警通道完全隔离：
  - 支持选择本地 SQLite 近 30 个已录制交易日（常规分时补齐同步落盘腾讯/东财近 5 日数据，新下载开箱即用），选中后默认一次性推演至 `15:00` 并立即可见全天急放/急缩三角与回放异动流。
  - 提供完整播控条：从头播放（`09:25 → 15:00`）、播放/暂停、倍速切换（`1x / 2x / 4x / 8x`）、时间轴拖拽定位（Seek）、单步前后退（`-1m / +1m`）、键盘快捷键（`Space / ← / →`）及点击异动记录自动定位对应标的与分钟。
  - 提供独立临时参数调优区（默认继承实盘配置），支持在不影响实盘的情况下调参重演、一键重置及「应用为实盘配置」持久化热生效。
  - 回放告警严格仅存内存并带有 `[回放]` 前缀，绝不写入 `alert_events` 或弹出系统通知；新增独立的回放提示音开关（默认静音，开启后仅在动态播放推进触发时发声）。
- 普通「分时能量」页签在盘后/休市静态复盘（非午休）且当日无实盘告警记录时，新增引导横幅一键携带当前标的与日期跳转至「复盘回放」控制台。

### Fixed
- 将 [SecretStore](src/main/storage/secretStore.ts) 与主进程凭据初始化/IPC 链路全面迁移至 Electron 45+ 异步 `safeStorage` API（`isAsyncEncryptionAvailable` / `encryptStringAsync` / `decryptStringAsync`），消除运行时同步接口废弃告警并支持自动重加密回写。
- 统一复用序列缺口守卫 `hasSeriesGap`，补齐回放引擎对历史分钟缺口（`SERIES_GAP` / `SERIES_INCOMPLETE`）与残缺基线日（`PREV_SERIES_INCOMPLETE`）的显式降级标识，以及日历缓存滞后时的本地基线日解析。
- 后台异步补齐自选股或新分钟线落盘后按需自动刷新回放缓存，确保切换页签重挂载与播放期间参数草稿编辑互不覆盖。

### Docs & CI
- 精简 [README.md](README.md) 为面向终端用户的简洁介绍，并将技术栈、算法口径、数据源策略及开发打包说明拆分至独立技术文档 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。
- 新增轻量规范 [docs/specs/interactive-replay-console.md](docs/specs/interactive-replay-console.md) 并登记至 [docs/specs/README.md](docs/specs/README.md)。
- 配置 GitHub Release 构建工作流自动从 `CHANGELOG.md` 提取对应版本变更记录作为 Release Notes。

## [0.1.6] - 2026-11-26

### Fixed
- 加固系统托盘图标构建：移除 `nativeImage.addRepresentation` 中传入 PNG `Buffer` 时的冗余 `width`/`height` 参数，并新增 `isEmpty()` 多级兜底回退（`createFromBuffer` → `createFromDataURL`），防止空图进入缓存（Issue #1）。
- 加固 Windows 系统托盘生命周期管理：在 `TrayManager` 中增加托盘区域检测（`getBounds`）、有界退避自动重试与交互事件自动转正机制，并保留托盘实例以响应资源管理器重启后的 `TaskbarCreated` 自动恢复。
- 新增无托盘兜底操作入口：当系统托盘不可用时在 HUD 展示可忽略的提示横幅（提供「重试托盘」「设置」「退出」），并在详情设置页常驻「重建托盘图标」与「退出应用」按钮，避免托盘异常时无法设置或退出程序。

## [0.1.5] - 2026-11-26

### Added
- 标准模式桌面悬浮窗（HUD）支持拖动四边或四角自由缩放（尺寸范围 `340×360` 至 `720×960` 并自动受显示器工作区钳制），内容随窗口尺寸自适应（拉宽展示更长标的名称、拉高展示更多自选股行）。
- 标准模式自定义窗口尺寸与缩放后的坐标经防抖持久化写入本地 SQLite（退出或切入极简模式前自动刷盘），重启及在标准/极简模式间往返切换后自动恢复。
- 极简模式继续保持固定紧凑尺寸（`320×212`）且禁止缩放，不污染标准模式自定义尺寸。

### Docs & Specs
- 新增轻量规范 [`docs/specs/hud-resizable-standard-mode.md`](docs/specs/hud-resizable-standard-mode.md)，并登记至 `docs/specs/README.md`。

## [0.1.4] - 2026-11-26

### Fixed
- 修复未配置同花顺 API Key 时，自选股搜索降级至东方财富与腾讯公开接口后将沪深场内 ETF/LOF（如 `588170`、`510300`、`159915`、`161005`）全部过滤导致无法搜到与添加的问题，同时继续排除无盘中分时的场外开放式基金与非沪深标的。
- 修复场内 ETF/LOF 价格在 HUD、自选管理列表、详情头部与分时图 Tooltip/右轴被截断为 2 位小数的问题，现按沪深场内基金代码规则保留 3 位小数展示。
- 补全自选股搜索无匹配结果时的空态提示，并新增搜索结果「场内基金」标签标识。

### Docs & Specs
- 新增轻量规范 [`docs/specs/watchlist-etf-search-fallback.md`](docs/specs/watchlist-etf-search-fallback.md)，同步更新 `docs/specs/README.md` 与 `docs/DATA_SOURCES.md` 公开搜索过滤口径说明。

## [0.1.3] - 2026-11-25

### Changed
- 优化双端打包配置，Windows 发行产物切换为便携 `.zip`，CI 构建时自动同步 Git Tag 版本号，并新增自定义应用图标。

## [0.1.2] - 2026-11-25

### Fixed
- 修复 Tag 触发 GitHub Actions 构建时 `electron-builder` 隐式尝试发布导致的 CI 失败问题。

## [0.1.1] - 2026-11-25

### Fixed
- 修复 `TrayManager` 点击行为单测在 macOS CI 环境下的平台差异问题。

## [0.1.0] - 2026-11-25

### Added
- 首个完整版本发布：完成 Phase 0–6 核心能量看板、混合双源采集调度、Electron 暗色悬浮窗 HUD（含极简模式）、详情双图、系统托盘与老板键、盘后复盘与收盘集合竞价校准、Windows / macOS 双平台打包工作流及旧目录数据平滑迁移。
