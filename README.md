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
  i18n       五语种目录 + i18next 实例 + 语言解析
  fingerprint 项目画像探测（技术栈指纹 / 评分画像 profileSync）
  guard      Git Hook / CI 门禁
  inspect    质量扫描适配器
  security   漏洞 / 垃圾 / 恶意代码
  dependency 依赖治理（依赖图 / SBOM / 许可证矩阵）
  performance 前端性能静态分析（包体积 / 构建配置 / tree-shaking）
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

## 工具规则包三层架构

工具规则（semgrep / trivy / eslint / dep-cruiser 的扫描规则文件）采用三层流转，规则内容只维护在 YAML 源文件中，任何一层都不再硬编码：

```
① 规则包源文件（YAML）          ② 加载器                     ③ API 服务
packages/kernel/src/sop/        packages/server/src/sop/      packages/server/src/sop/
  tool-packs/<tool>/…            tool-rule-loader.ts           tool-rule.controller.ts
        │                            │  loadToolRuleFiles()        │  GET /api/v1/rules/:tool/…
        └──────── load ──────────────┴───────── 注入 ──────────────┘
                                                             │
                                             packages/kernel/src/sop/sync/tool-rule-sync.ts
                                             （桌面端客户端：比对 version → 下载 → 哈希校验落盘）
```

- **第 1 层 · 规则包源文件**：`packages/kernel/src/sop/tool-packs/<tool>/` 下按工具分目录存放 YAML（如 `semgrep/rules/backdoor.yaml`、`trivy/policy/ignore.yml`）。这是规则的唯一事实来源。
- **第 2 层 · ToolRuleLoader**：`packages/server/src/sop/tool-rule-loader.ts` 扫描 tool-packs 目录，输出与同步契约一致的 `{ filename, content }[]`（filename 为工具目录下的 POSIX 相对路径）。目录缺失或单个文件不可读时优雅降级（跳过 / 返回空）。
- **第 3 层 · ToolRuleController**：`packages/server/src/sop/tool-rule.controller.ts` 构造时通过 loader 一次性快照各工具的规则包，对外提供：
  - `GET /rules/:tool/version` — `{ toolId, version, hash, size, publishedAt }`；`hash` 为 `hashToolRuleFiles(payload)`，`version = 1.<hash 前 12 位>` 由内容派生，**规则文件一改，version 自动变化**，桌面端才会触发增量同步；
  - `GET /rules/:tool/download` — 规则文件数组（JSON），客户端写盘后按同一哈希算法校验；
  - `GET /rules/:tool/emergency` — 应急通道，当前镜像本地规则包。

### 如何新增 / 修改一个规则包

1. 在 `packages/kernel/src/sop/tool-packs/<tool>/` 下新增或编辑 YAML 文件（目录名须为 `semgrep` / `trivy` / `eslint` / `dep-cruiser` 之一）。
2. 重启后端（controller 在启动时快照规则包）：`pnpm --filter @zh/server dev`。
3. 验证：`curl http://localhost:3010/api/v1/rules/<tool>/version`，确认 `version`/`hash` 已随内容变化；桌面端下次同步即拉取新规则。

> 注意：新增工具 ID 需同步扩展 controller 的 `VALID_TOOLS` 与 kernel `buildDefaultToolRuleConfigs()` 的同步配置。

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

---

## GitHub Action — 0Token 门禁（已交付）

智汇码盾已打包成 GitHub Action，任何仓库只需几行 YAML 即可启用门禁，全程 0 Token（不耗 CodeQL / 额外 Token）。

### 使用方式

在目标仓库新增 `.github/workflows/zhshield.yml`：

```yaml
name: zhshield-guard
on: [push, pull_request]

jobs:
  guard:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      security-events: write   # 用于上传 SARIF 到安全面板
    steps:
      - uses: actions/checkout@v4
      - name: 智汇码盾门禁
        uses: liangdawei3927-commits/zhshield-action@v1
        # 0 Token：无需任何 token 配置
```

### 实现要点

- **不依赖 npm**：命令行打包进仓库，action 从 GitHub 自动下载安装（`GITHUB_ACTION_REPOSITORY` 识别仓库，默认 `liangdawei3927-commits/zhshield-action` + `v1`）。
- **云端适配**：GitHub runner 需 `sudo` 才能写 `/usr/local`（已修）；自动识别仓库名与版本。
- **结果上报**：SARIF 漏洞报告自动上传到 GitHub Security（需 `security-events: write` 权限）。

### 已验证

在真实仓库 `zhshield-demo` 中实测：action 自动安装 → 执行智汇码盾 → 生成报告 → SARIF 上传安全面板，全程 0 Token，流程真实可用。

### 待补足（产品缺口）

云端 CI 的「密钥/漏洞自动拦截（报红阻断）」目前只接在本地 pre-commit 检测中，云端门禁的拦截编排尚未配全 —— 这是后续要补的产品功能，非演示脚本问题。
