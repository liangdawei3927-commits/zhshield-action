# 智汇码盾 (ZhiYan CodeShield)

模块化单体代码治理平台 — 用 SOP 元规则编排开源扫描工具（ESLint / Semgrep / Trivy / gitleaks 等），保护 TypeScript / NestJS 代码质量与安全。

## 要求

- Node.js >= 20
- pnpm >= 9（推荐 11）

## 快速开始

```bash
./start.sh init          # 安装依赖
./start.sh hooks         # 安装 pre-commit hooks（可选）
./start.sh dev:desktop   # 启动 Electron 桌面端
./start.sh dev:server    # 启动 NestJS 后端
./start.sh status        # 查看包列表与环境
```

或直接使用 pnpm：

```bash
pnpm install
pnpm --filter @zh/desktop dev
pnpm --filter @zh/server dev
```

## 常用命令

| 命令 | 说明 |
|------|------|
| `pnpm build` | Turborepo 构建全部包 |
| `pnpm test` | 运行全部 Vitest |
| `pnpm lint` | ESLint（各包 `src`） |
| `pnpm check` | 智汇码盾自检（refactor / inspect） |
| `./start.sh build:mac` | 打包 macOS DMG |

## 包结构

```
packages/
  kernel     SOP 规则引擎 / EventBus / 同步缓存
  shared     共享类型与 ToolAdapter 契约
  db         SQLite + migrations
  guard      Git Hook / CI 门禁
  inspect    质量扫描适配器
  security   漏洞 / 垃圾 / 恶意代码
  refactor   AST 异味与自动修复
  sentinel   监控告警
  scoring    健康评分
  evolve     经验池与规则权重
  pipeline   编排 Guard + Inspect + Refactor
  reporter   控制台报告
  cli        zhshield 命令行
  server     NestJS HTTP API
  desktop    Electron + React 桌面端
```

依赖方向：客户端 → 引擎 → `kernel` / `shared` / `db`。引擎之间不互相 import，横向通信走 EventBus。

## 文档

产品与架构说明见仓库上级目录 [`00-项目文档`](../00-项目文档/README.md)。

## 本地智汇大脑联调

默认生产 API 为 `https://api.zhishield.com/api/v1`。本地开发请指向 Nest 服务：

```bash
# 终端 1：后端
pnpm --filter @zh/server dev

# 终端 2：桌面端（同步 SOP / 工具规则 / 经验回写到本地）
ZH_API_BASE=http://localhost:3010/api/v1 pnpm --filter @zh/desktop dev
```

环境变量：
- `ZH_API_BASE` — 优先（Electron 主进程与 kernel 同步客户端）
- `VITE_API_BASE` — 渲染进程 HTTP 模式备用
