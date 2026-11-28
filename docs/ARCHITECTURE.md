# 技术架构与开发指南（ashare-volpulse）

本文档面向开发者与进阶用户，说明 `ashare-volpulse` 的技术栈、架构分工、金融计算口径、数据源与降级策略、安全凭据机制、本地开发测试以及双端打包发布流程。

---

## 1. 技术栈与运行时约束

| 层级 | 选型与核心约束 |
| --- | --- |
| **桌面外壳** | Electron 45（纯桌面双态窗口 + 系统托盘，无独立浏览器 Web 页面） |
| **语言与界面** | TypeScript + React 19 + ECharts 6（按需引入 + 单实例复用增量 `setOption`） |
| **本地持久化** | Electron 内置 `node:sqlite`（滚动保留近 30 个交易日，**零 MSVC / `node-gyp` C++ 编译依赖**） |
| **进程隔离** | `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`；渲染进程通过 `src/preload/index.ts` 类型安全 `contextBridge` IPC 通信 |
| **凭据加密** | Electron 45 异步 `safeStorage` API（`isAsyncEncryptionAvailable` / `encryptStringAsync` / `decryptStringAsync`）→ Windows DPAPI / macOS Keychain |

---

## 2. 进程分工与核心模块

- **纯领域引擎（`src/core/`，零 Electron / DOM / 网络依赖）**：
  - `tradingClock.ts`：A 股交易阶段识别、`11:30–13:00` 午休折叠、`minuteIndex` (`0..239`) 映射与时间标注。
  - `marketAggregator.ts`：沪深两市总成交额聚合、双边时间对齐与单边缺失显式降级。
  - `energyEngine.ts`：昨日同期线性插值、多日分时占比 + 剩余时段贝叶斯收缩全天预测、滚动边际量比与 OLS 趋势斜率。
  - `alertEngine.ts`：`09:30–09:34` 冷启动保护、全局与单股覆写阈值判定、按 `(symbol, direction)` 冷却去重。
- **主进程（`src/main/`）**：
  - **行情调度（`scheduler/`）**：盘中高频批量快照与分时补齐、自适应指数退避、主备切源恢复探测、盘后收盘集合竞价（`15:00:15` 与 `15:02:00`）终态校准，以及新落盘通知。
  - **独立复盘回放（`replay/`）**：`DayReplayEngine` 负责逐帧推演并支持命令行 `--replay`；`InteractiveReplayController` 一次性预计算 `09:25 → 15:00` 全天 241 帧快照，支持毫秒级确定性 `Seek`、倍速播放、临时参数试调与一键应用至实盘；与实盘轮询、HUD、实盘 `alert_events` 及系统通知完全隔离。
  - **桌面窗口与托盘（`windows/`、`tray/`、`alerts/`）**：双态悬浮窗管理（标准模式支持 `340×360`–`720×960` 自由缩放与防抖坐标持久化；极简模式锁定 `320×212`）、系统托盘生命周期加固（`TaskbarCreated` 自动恢复与无托盘兜底）、全局老板键及多通道告警派发。
- **渲染进程（`src/renderer/`）**：
  - `hud/`：暗色半透明紧凑 HUD（标准模式 / 极简模式），遵循 A 股红涨绿跌视觉规范。
  - `detail/`：详情浮层窗口，包含「分时能量」双图、`ReplayConsolePanel` 独立「复盘回放」控制台、「自选股」管理、「异动事件流」（已读/未读管理）与「设置」页。
  - `audio/`：基于 Web Audio 的急放/急缩区分短提示音（支持实盘静音与回放独立静音开关）。

---

## 3. 大盘口径与核心算法

### 3.1 大盘成交额防重复累加口径

| 展示对象 | 标准代码 (`thscode`) | UI 口径角标 | 说明 |
| --- | --- | --- | --- |
| **沪深两市总成交额** | `000001.SH` + `399106.SZ` | `两市全市场` | 沪市全市场（含科创板）+ 深市全市场（含创业板），**不含北证**，绝不直接叠加各指数 |
| 上证指数 *(默认开启，可关闭)* | `000001.SH` | `全市场` | 沪市全市场成交额（关闭展示不影响顶部两市总成交额聚合） |
| 深证成指 *(默认开启，可关闭)* | `399001.SZ` | `全市场` | 实测四源均返回深市全市场成交额（同 `399106.SZ`） |
| 创业板指 *(默认开启，可关闭)* | `399006.SZ` | `全市场` | 腾讯/新浪口径等于创业板全市场（同 `399102.SZ`） |
| 科创综指 *(默认开启，可关闭)* | `000680.SH` | `全市场` | 实测四源均返回科创板全市场成交额 |
| 上证50 / 沪深300 / 中证1000 / 科创50 *(默认关闭，可开启)* | `000016.SH` / `000300.SH` / `000852.SH` / `000688.SH` | `成分股` | 各宽基成分股成交额，按需开启，不参与两市总成交额累加 |

### 3.2 核心量能与告警公式

大盘聚合、指数与所有自选股（含沪深场内 ETF/LOF）共用 `src/core/` 下的同一套纯领域引擎：

- **昨日同期累计对比**：盘中未闭合分钟按已过秒数 $s/60$ 对昨日同分钟做线性插值，避免每分钟前几秒产生假骤缩锯齿；同比偏离默认 $\ge +5\%$ 判放量、$\le -5\%$ 判缩量。
- **全天预测成交额（多日分时占比 + 剩余时段贝叶斯收缩）**：
  - 取本地 SQLite 最近最多 `10` 个历史完整交易日计算平均分钟累计占比 $\bar{w}(t)$（不足时自动回退已有天数 / 昨日）；
  - 将全天拆分为「已成交部分 + 剩余时段预测」，按置信权重 $\alpha(t)=\frac{\bar{w}(t)}{\bar{w}(t)+\lambda}$（默认 $\lambda=0.12$）平滑收缩剩余时段倍率，消除开盘前几分钟高/低开带来的预测剧烈失真，同时保证平量无偏、收盘零误差。
- **滚动边际量比与趋势斜率**：
  - 计算最近 $W$ 分钟（`3 / 5 / 10` 可选）边际成交额相对昨日同一 $W$ 分钟的区间倍数 $M_W(t)$ 与偏离 $D_W(t)=(M_W(t)-1)\times 100\%$（自动剔除 `09:25` 集合竞价干扰，早盘与尾盘量纲完全一致，消除午后大基数钝化）；
  - 对最近 $W$ 个连续时刻的 $D_W(k)$ 做 OLS 线性回归得到边际趋势斜率 $S_W(t)$（单位：百分点/分钟）；
  - `09:30–09:34` 冷启动保护不触发斜率告警；默认急放 $S_W \ge +3.0\%/\text{分}$ 且 $M_W \ge 1.5\text{x}$，急缩 $S_W \le -3.0\%/\text{分}$ 且 $M_W \le 0.65\text{x}$，同标的同方向默认 `5` 分钟冷却防刷屏。
- **真实数据完整性**：上游缺失、跨源口径冲突或分钟序列存在缺口时，界面显式标注降级/陈旧标识，绝不对缺失成交额补零，绝不用模拟数据冒充实盘行情。

---

## 4. 数据源策略与安全卫生

### 4.1 各数据源职责总览

| 数据源 | 适配器 | 核心职责 | 特点与边界 |
| --- | --- | --- | --- |
| **腾讯财经** (`tencent`) | `tencentProvider.ts` | **主力快照源** + **主力 1 分钟分时源** + 搜索兜底 | 高频稳定、延迟低；与新浪在全标的（含 `399006.SZ`）成交额口径 100% 一致；`day/query` 单次返回近 5 个交易日 1 分钟数据 |
| **新浪财经** (`sina`) | `sinaProvider.ts` | **快照第一备源** + 交易日历降级开市探测 | 高频稳定且与腾讯口径完全一致，支持无缝热切换；公开接口无 1 分钟成交额分时，不参与分时补齐 |
| **东方财富** (`eastmoney`) | `eastmoneyProvider.ts` | **1 分钟分时第一备源** + 搜索第一备源 + `399006.SZ` 口径对齐 | `push2his` 支持近 5 日 1 分钟增量成交额；公开搜索支持沪深个股与场内 ETF/LOF；因 `push2` 高频快照会断连，**不接入**实时快照轮询 |
| **同花顺 Fuyao** (`hithink`) | `hithinkProvider.ts` | **权威交易日历** + **权威标的搜索** + **快照紧急低频兜底** | 需配置 API Key；受 `code=4001` 动态限流约束，严禁高频轮询；无历史分钟线接口；快照不返回中文名且 `399006.SZ` 口径与腾讯/新浪存在差异 |

### 4.2 优先级与降级链路

| 业务职责 | 优先级与降级链路 | 触发条件与恢复策略 |
| --- | --- | --- |
| **盘中高频批量实时快照**<br>（默认 3s，可配 3–15s） | **腾讯财经** `qt.gtimg.cn`<br>→ **新浪财经** `hq.sinajs.cn`<br>→ **同花顺 Fuyao**（仅配置 Key 时，强制降频 ≥ 15s） | 遇限流（429/403）**立即切源**，或连续失败 **3 次**切源；失败期间指数退避翻倍（上限 30s），切源后立即补拉一次。切离主源后每 **5 分钟**探测腾讯健康状态，恢复即切回；滞留同花顺时同步探测新浪。若切至同花顺，对 `399006.SZ` 禁止混写跨口径快照并尝试通过东财分时重拉对齐。 |
| **近 5 日 1 分钟分时补齐**<br>（启动 / 盘前 / 缺口 / 新增自选） | **本地 SQLite 缓存**<br>→ **腾讯财经** `day/query`（近 5 日）<br>→ **东方财富** `push2his trends2`（近 5 日） | 优先读取本地缓存；仅在昨日不足 240 根、今日有缺口或缺少竞价锚点时联网补齐（并发度 2、间隔 150ms、单标重试冷却 120s），并将同次返回的近 5 日完整落盘（零额外请求）。双源均失败时标注降级，绝不补零。 |
| **交易日历**<br>（开市判定与上一交易日） | **SQLite 当日缓存**<br>→ **同花顺 Fuyao** `/api/a-share/calendar/trading-days`<br>→ **SQLite 旧缓存**<br>→ **公开源降级推断** | 每日首次启动同步 1 次并缓存。无 Key 或日历异常时，由公开分时日期与工作日 `09:15–15:10` 快照探测自动判断休市/开市，界面同步标注日历降级态。 |
| **自选股搜索与代码消歧** | **同花顺 Fuyao** `/api/meta/tickers/search`<br>→ **东方财富** `searchapi` 联想<br>→ **腾讯财经** `smartbox` | 未配置 Key、请求异常或返回为空时自动顺次降级；公开联想同时覆盖沪深 A 股、指数与沪深场内 ETF/LOF（排除无盘中分时的场外基金）。 |

### 4.3 不配置同花顺 API Key 时的运行说明

- **同花顺 API Key 为完全可选配置**：不配置 Key 时仍可正常完成盘中 3 秒实时快照（腾讯 + 新浪热备）、近 5 日 1 分钟分时补齐（腾讯 + 东财热备）、两市总成交额聚合、放缩量/斜率/预测计算、桌面告警、独立复盘回放与自选股管理。
- **差异仅在于两项**：交易日历自动改走公开分时与开盘窗快照探测推断（状态栏提示 `inferred_degraded`）；极端情况下若腾讯与新浪快照同时不可用，无第三层同花顺 15s 紧急兜底。

### 4.4 同花顺 Fuyao API 接入与安全卫生

- **官方仓库与后台**：[HiThink-Tech/Financial-API](https://github.com/HiThink-Tech/Financial-API) · [同花顺 Fuyao 管理后台](https://fuyao.aicubes.cn/admin)
- **API Key 读取优先级**（严禁写入代码、Git、URL 查询参数或日志）：
  1. 软件内设置页异步 `safeStorage` 加密存储（保存后立即清空输入框，永不回显明文；保存后即时重载权威交易日历）；
  2. 环境变量 `HITHINK_FINANCE_API_KEY`；
  3. 用户级 `credentials.env`：Windows `%APPDATA%\hithink-finance\credentials.env`、macOS `~/Library/Application Support/hithink-finance/credentials.env`。
- **本地留存**：使用 Electron 内置 `node:sqlite` 滚动保留近 **30 个交易日** 数据，存放在系统 `%APPDATA%` / `Application Support` 目录。

---

## 5. 目录结构

```text
ashare-volpulse/
├── docs/
│   ├── ARCHITECTURE.md           # 本文档（技术栈、算法口径、数据源与开发指南）
│   ├── PLAN.md                   # 权威实施计划、领域规范与数学公式
│   ├── DATA_SOURCES.md           # 数据源实测调研、口径核验与限流预算
│   ├── images/                   # 功能界面截图
│   └── specs/                    # 分阶段 Spec 与独立 Feature Spec
├── scripts/
│   ├── spike-data-sources.mjs    # 数据源可用性与限流探针脚本
│   ├── verify-replay.mjs         # 本地真实录制交易日离线回放校验脚本
│   ├── package-app.mjs           # Windows / macOS 双端打包脚本
│   └── extract-changelog.mjs     # 从 CHANGELOG.md 提取 Release 说明脚本
├── src/
│   ├── shared/                   # 共享类型、IPC 契约、常量、图表数据构建、序列守卫
│   ├── core/                     # 纯 TypeScript 领域引擎（时钟、聚合、量能预测、告警）
│   ├── main/                     # Electron 主进程
│   │   ├── providers/            # 腾讯 / 新浪 / 东财 / 同花顺适配器
│   │   ├── scheduler/            # 自适应分层轮询与容错调度器
│   │   ├── replay/               # 全天回放引擎（--replay）与独立回放控制器（InteractiveReplayController）
│   │   ├── storage/              # node:sqlite 持久层、配置/自选股服务、异步 safeStorage 密钥库
│   │   ├── windows/              # HUD / 详情浮层几何定位与双态窗口管理
│   │   ├── tray/                 # 动态系统托盘（含容错重试）与全局老板键管理
│   │   └── alerts/               # 多通道告警派发器（落库 + 系统通知 + IPC）
│   ├── preload/                  # contextBridge 类型安全桥接
│   └── renderer/                 # React + ECharts 渲染进程（HUD、详情双图、回放控制台、提示音）
├── tests/                        # Vitest 单元测试（core / providers / scheduler / storage / shell / replay / renderer / scripts）
├── electron-builder.yml          # Windows / macOS 打包配置
└── package.json
```

---

## 6. 本地开发、测试与打包发布

### 6.1 环境要求
- Windows 10 / 11（x64）或 macOS 12+（Apple Silicon `arm64` / Intel `x64`）
- Node.js 22+（推荐 Node 24/26，无需安装 Visual Studio / MSVC）

### 6.2 常用命令

```bash
# 安装依赖（零本地 C++ 编译）
npm install

# 启动本地开发模式（含 HMR）
npm run dev

# TypeScript 严格类型检查（主进程 + 渲染进程）
npm run typecheck

# 运行全套 Vitest 单元测试
npm run test

# 构建 Electron 生产产物（out/）
npm run build

# 打包 Windows 便携解压版 .zip（自动同步最新 git tag 版本，输出至 release/）
npm run package:win

# 打包 macOS Apple Silicon + Intel 安装包 .dmg（需在 macOS 下执行）
npm run package:mac
```

### 6.3 开发态命令行全天回放验证

除了桌面端详情浮层内置的「复盘回放」控制台，开发与测试阶段也可通过命令行离线或启动全窗口回放校验：

```bash
# 方式 1：只读离线全天回放校验脚本（默认读取 %APPDATA%\ashare-volpulse\ashare-volpulse.sqlite）
npm run verify:replay
node scripts/verify-replay.mjs --db <sqlite路径> --date 2026-11-24

# 方式 2：以命令行 --replay 模式启动 Electron 全窗口加速回放指定交易日
npm run build
npx electron . --replay 2026-11-24 --replay-step-ms=100
```

### 6.4 双平台自动发布（GitHub Release）

项目已配置 [.github/workflows/release.yml](../.github/workflows/release.yml)，更新 [CHANGELOG.md](../CHANGELOG.md) 后推送 `v*` 格式标签，即可并行构建 Windows（x64 免安装 `.zip`）与 macOS（`arm64` / `x64` `.dmg`），自动提取对应版本更新日志并附带 `SHA256SUMS.txt` 发布至 GitHub Release：

```bash
git tag v0.1.7
git push origin v0.1.7
```

---

## 7. 相关权威文档

- 权威实施计划与数学定义：[docs/PLAN.md](PLAN.md)
- 数据源实测调研与限流报告：[docs/DATA_SOURCES.md](DATA_SOURCES.md)
- 分阶段与 Feature 规格索引：[docs/specs/README.md](specs/README.md)
- 版本更新历史：[CHANGELOG.md](../CHANGELOG.md)
