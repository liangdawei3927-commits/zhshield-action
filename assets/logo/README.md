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
| `app-icon.svg` | **App 图标母版** 1024³，图形占比约 70%，用于 Dock / DMG / 安装包 |
| `app-icon-small.svg` | 同上但加粗描边，专供 ≤64px 渲染，保证小尺寸下 `<_` 仍可辨 |
| `logo.svg` | 主 LOGO 展示版（图形占比略小、留白更松），用于文档 / 报告 / 对外物料 |
| `logo-mark.svg` | 透明底图形标，盾青渐变描边，用于浅色界面与水印 |
| `logo-dark.svg` | 暗色场景版，墨黑底 + 提亮青蓝 `#2DD4BF` |
| `favicon.svg` | 站点 favicon（24×24 版，已接入 `index.html`） |

### png/ 位图导出

| 前缀 | 尺寸 | 说明 |
|:--|:--|:--|
| `app-icon-*` | 16 / 32 / 64 / 128 / 256 / 512 / 1024 | App 图标各档；16–64 取自加粗变体 |
| `logo-*` | 512 / 1024 | 主 LOGO 展示版 |
| `logo-mark-*` | 256 / 1024 | 透明底图形标 |
| `logo-dark-*` | 512 / 1024 | 暗色场景版 |

### 根目录打包产物

| 文件 | 说明 |
|:--|:--|
| `icon.icns` | macOS App 图标容器，含 11 个条目（icp4/5/6、ic07–ic10、ic11–ic14），同步于 `packages/desktop/build/icon.icns` |
| `favicon.ico` | Windows / Web 用图标容器，含 16 / 32 / 48 三档 |

## 三、已落地位置（改动记录）

| 位置 | 内容 |
|:--|:--|
| `packages/desktop/build/icon.icns` | 替换为新图标（原为黑色节点占位图） |
| `packages/desktop/build/icon.png` | 新增，1024 通用位图（electron-builder fallback） |
| `packages/desktop/build/logo/*.svg` | 新增，随包分发的矢量源 |
| `packages/desktop/public/favicon.svg` + `index.html` | 新增 favicon 并接入 `<link rel="icon">` |
| `packages/desktop/src/components/ui/Icons.tsx` | 组件注释修正（`<-` 箭头 → `<_` 终端提示符） |

UI 内 6 处 LOGO（顶部栏、侧栏、欢迎页、屏保、项目引导页）全部引用 `ShieldLogo` 同一组件，已天然与新 LOGO 统一，无需逐页替换。

## 四、重新生成方式

下次调整图形或配色时，按此顺序重建（工具已装在受管运行时目录，未污染系统环境）：

1. 改 `source/*.svg`（保持 24×24 原始坐标不改，只调整色值与缩放）
2. 渲染各尺寸 PNG：`node ~/.workbuddy/binaries/node/workspace/export-logo-pack.js`
3. 重建 macOS 图标：`python ~/.workbuddy/binaries/node/workspace/make-icns.py`
4. 重建 favicon.ico：`python ~/.workbuddy/binaries/node/workspace/make-ico.py`
5. 把 `icon.icns` / `icon.png` / `source/*.svg` 同步回 `packages/desktop/build/` 与 `public/`
6. 重新打包后请 `killall Dock` 刷新系统图标缓存

> 环境备忘：本机 `iconutil` 会拒收 resvg 输出的 PNG（报 Invalid Iconset），`qlmanage` 与 cairo 均不可用，故 icns/ico 均为手写容器格式；resvg-js 已装在 `~/.workbuddy/binaries/node/workspace/node_modules`。
