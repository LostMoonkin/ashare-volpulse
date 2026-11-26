# Changelog

本文件记录 `ashare-volpulse` 的主要变更历史。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

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
