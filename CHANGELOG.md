# Changelog

本文件记录 `ashare-volpulse` 的主要变更历史。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

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
