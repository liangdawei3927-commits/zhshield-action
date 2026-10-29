# 智汇码盾品牌资源包（LOGO / 图标）

集中存放智汇码盾全套 LOGO 与图标矢量、位图与打包产物，**后续查看、取用、修改都从这里进**。

## 一、图形与色彩的唯一事实源

- **图形**：`packages/desktop/src/components/ui/Icons.tsx:4` 的 `ShieldLogo` 组件（24×24 白色描边）
  - 盾牌外框：`M12 2L3 6.5V12C3 17.25 6.84 22.09 12 23.5C17.16 22.09 21 17.25 21 12V6.5L12 2Z`（尖顶盾）
  - 盾内符号：`<` = `M8 10L5.5 12.5L8 15` ＋ 底部横线 `_` = `line (12,15)→(17,15)`
  - 线宽比：盾牌 `1.5` / 符号 `1.8`
- **色彩**：`00-项目文档/03-产品设计/07-品牌视觉规范.md` v1.0
  - 主色 600「盾青」`#0E8C7F` —— Logo 底色渐变起点
  - 700「墨青」`#0A6B61` —— 渐变深端（规范允许的最深档）
  - 暗色提亮档 `#2DD4BF` —— 暗底专用（规范 §6.1）
  - 旧主色 `#19C37D` 已禁用（规范 §1.3 / §8.1）

本资源包内所有文件均由上述两者派生，**未另起设计**；所有矢量文件的原始坐标与 24×24 版完全一致，只做了等比缩放。

## 二、文件清单

### source/ 矢量源（可无限缩放，改稿从这里动）

| 文件 | 用途 |
|:--|:--|
| `app-icon.svg` | **App 图标母版** 1024³，用于 Dock / DMG / 安装包（≥128px 档） |
| `app-icon-small.svg` | 几何同上、描边加粗，专供 64px 档，保证 `<_` 不糊 |
| `app-icon-tiny.svg` | **仅保留盾牌轮廓**（去掉 `<_`），供 16 / 32px 档使用 |
| `logo.svg` | 主 LOGO 展示版（图形占比略小、留白更松），用于文档 / 报告 / 对外物料 |
| `logo-mark.svg` | 透明底图形标，盾青渐变描边，用于浅色界面与水印 |
| `logo-dark.svg` | 暗色场景版，墨黑底 + 提亮青蓝 `#2DD4BF` |
| `favicon.svg` | 站点 favicon（24×24 版，已接入 `index.html`） |

### png/ 位图导出

| 前缀 | 尺寸 | 说明 |
|:--|:--|:--|
| `app-icon-*` | 16 / 32 / 64 / 128 / 256 / 512 / 1024 | App 图标各档；16–32 取 tiny 档、64 取 small 档 |
| `logo-*` | 512 / 1024 | 主 LOGO 展示版 |
| `logo-mark-*` | 256 / 1024 | 透明底图形标 |
| `logo-dark-*` | 512 / 1024 | 暗色场景版 |

### 根目录打包产物

| 文件 | 说明 |
|:--|:--|
| `icon.icns` | macOS App 图标容器，含 11 个条目（icp4/5/6、ic07–ic10、ic11–ic14），同步于 `packages/desktop/build/icon.icns` |
| `favicon.ico` | Windows / Web 用图标容器，含 16 / 32 / 48 三档 |
| `比例对标-Cursor.png` | App 图标比例校准的验收图（并排 + 安全区参考线 + 三项实测值），改比例后需重出 |

## 三、App 图标比例校准（实测依据）

图标"比别人大一圈"与"盾牌过大"是两类可量化问题，**基准取 Cursor**（与本项目同构：圆角方块底 + 独立图形），并参考本机 15 款 App 校准：

| 指标 | Cursor 实测 | 校准前 | 校准后 |
|:--|:--|:--|:--|
| 内容区（背景方块）/ 画布 | **80.1%**（= Apple 安全区 824/1024） | 100% ❌ | **80.1%** ✅ |
| 图形宽 / 背景方块 | **61.6%** | — | **60.6%** ✅ |
| 图形高 / 背景方块 | **71.2%**（差值法口径） | 80% ❌ | **71.6%** ✅ |

- **为什么基准取 Cursor 而不是中位数 80.5%**：Safari / Chrome / Mail / Notes 等系统图标属于"背景即图形"的满铺型，图形 bbox 恒为 99.8%，对"底色 + 独立图形"结构没有参照价值；只有 Cursor 这类同构图标可对标，其内容区落在 80.1%，正是 Apple 824/1024 安全区的实际位置。
- **几何参数**：背景方块 `820×820`（x=y=102，rx=185），居中；盾牌 `scale=25.625`（= 旧版 25 × 820/800），`translate(204.5 185.28)`，使盾牌随背景等比放大、相对比例不变，水平垂直偏移均 <0.1%。
- **小尺寸降级策略**：≤32px 时背景方块仅约 26px，保留 `<_` 会糊成一团墨点，故 `app-icon-tiny.svg` 只保留盾牌轮廓（最核心记忆点）；64px 用 `app-icon-small.svg`（描边加粗 1.6×）保证符号可辨。

## 四、已落地位置（改动记录）

| 位置 | 内容 |
|:--|:--|
| `packages/desktop/build/icon.icns` | 替换为新图标（原为黑色节点占位图） |
| `packages/desktop/build/icon.png` | 新增，1024 通用位图（electron-builder fallback） |
| `packages/desktop/build/logo/*.svg` | 新增，随包分发的矢量源 |
| `packages/desktop/public/favicon.svg` + `index.html` | 新增 favicon 并接入 `<link rel="icon">` |
| `packages/desktop/src/components/ui/Icons.tsx` | 组件注释修正（`<-` 箭头 → `<_` 终端提示符） |

UI 内 6 处 LOGO（顶部栏、侧栏、欢迎页、屏保、项目引导页）全部引用 `ShieldLogo` 同一组件，已天然与新 LOGO 统一，无需逐页替换。

## 五、重新生成方式

下次调整图形或配色时，按此顺序重建（工具已装在受管运行时目录，未污染系统环境）：

1. 改 `source/*.svg`（保持 24×24 原始坐标不改，只调整色值与缩放；改比例前先看第三节的校准依据）
2. 重建 macOS iconset：`node ~/.workbuddy/binaries/node/workspace/build-iconset.js`
3. 重建 macOS 图标容器：`python ~/.workbuddy/binaries/node/workspace/make-icns.py`
4. 渲染各尺寸 PNG：`node ~/.workbuddy/binaries/node/workspace/export-logo-pack.js`
5. 重建 favicon.ico：`node ~/.workbuddy/binaries/node/workspace/make-ico.js`（从 `source/favicon.svg` 真实渲染 16/32/48 三档；**不要**用旧的 `make-ico.py`，它拿 64px 数据充 48px 条目，且源是带安全区的 app-icon，标签页里会偏小）
6. 出 contact sheet 自检（并排对比 + 缩放 + 深浅底）：`render-check.js` → `contact-sheet.py`
7. 把 `icon.icns` / `icon.png` / `source/*.svg` 同步回 `packages/desktop/build/` 与 `public/`
8. 重新打包后请 `killall Dock` 刷新系统图标缓存

比例若需复核，用两个脚本（口径不同，必须都跑）：

- `measure-icon-ratio.py` —— 与系统图标同批测「内容区/画布」。把 1024 PNG 放进 `/tmp/icon-sample/` 即可。
- `measure-shield.py` —— 精确测「图形 bbox / 背景方块」。**注意**：`measure-icon-ratio.py` 的第 2、3 列用逐行背景参考法，会被圆角方块的抗锯齿边缘污染（本图标实测被虚高到 95.9%），判断图形实际占比请只看 `measure-shield.py`。该脚本对深浅结构取不同前景阈值（我们取近白像素、Cursor 取亮度>90），对 Cursor 的「高」会因立方体暗面被截断而偏低（测出 52.9%，差值法口径为 71.2%），故 Cursor 的高度请以 `measure-icon-ratio.py` 的差值为准。

> 环境备忘：本机 `iconutil` 会拒收 resvg 输出的 PNG（报 Invalid Iconset），`qlmanage` 与 cairo 均不可用，故 icns/ico 均为手写容器格式；resvg-js 已装在 `~/.workbuddy/binaries/node/workspace/node_modules`。Node 运行时目录版本会变（曾 `22.22.2-3` → `-6`），脚本若报找不到 node，先 `ls ~/.workbuddy/binaries/node/versions/` 确认。
