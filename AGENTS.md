# zhiyan-codeshield 代码仓库规则

pnpm + Turborepo monorepo，19 个 `@zh/*` 包。依赖方向：客户端 → 引擎 → `kernel` / `shared` / `db`；引擎之间不互相 import，横向通信走 EventBus。

## ⛔ Git 安全红线（最高优先级）

2026-08-20 曾有 AI 子代理在本仓库执行 `git stash` + `git stash pop`，而当时仓库只有 1 个初始提交（8月3日），导致 256 个源文件被整体打回旧版、后续多轮工作丢失。为杜绝重演，以下命令**一律禁止**：

- `git stash` / `git stash pop` / `git stash drop`
- `git reset --hard`
- `git checkout -- .` / `git checkout <ref> -- .`
- `git restore .` / `git restore --source=...`
- `git clean -fd`

**如果发现工作区状态异常（文件丢失/内容回退）：立即停止操作，向用户报告现状与证据。不要试图用破坏性命令"修复"。**

### 硬拦截已生效（2026-08-22）

上述命令已在三层 opencode 配置中通过 `permission.bash` 规则 **硬性 deny**（全局 `~/.config/opencode/opencode.jsonc` + 外层 `opencode.json` + 本仓库 `opencode.json`），AI 执行会直接被拒绝。不要尝试绕过。

### 安全替代方案（必须用这些，不要用 stash）

| 需求 | 禁止 ❌ | 正确做法 ✅ |
|------|--------|-----------|
| 在干净代码树上跑测试/类型检查 | `git stash && test && git stash pop` | `git worktree add /tmp/wt-check HEAD` 后在 worktree 里跑 |
| 放弃某文件本地改动 | `git checkout -- <file>` / `git restore <file>` | 先 `git diff <file>` 备份内容到临时文件，问用户后再处理 |
| 撤销提交 | `git reset --hard` | `git revert`（生成反向提交） |

## 提交纪律

- 小步原子提交，语义化前缀（`feat:` / `fix:` / `chore:` / `refactor:`）
- 本地备份（`.zhshield/backups/` 与 `~/zhshield-backups/`）现已包含 `.git/`，恢复时会带回完整提交历史

## 常用命令

| 命令 | 说明 |
|------|------|
| `pnpm build` | Turborepo 构建全部包 |
| `pnpm test` | 全部 Vitest |
| `pnpm lint` | ESLint（各包 src） |
| `pnpm --filter @zh/<pkg> exec tsc --noEmit -p tsconfig.json` | 单包类型检查 |

## 编码规范

- **注释语言**：所有代码注释统一使用中文（与已有代码风格一致）
- **错误信息**：面向用户的 i18n 文案走 `translate()`，开发者日志/注释用中文
- **PATH 补全**：`packages/shared/src/path-augment.ts` 的 `augmentProcessPath()`，由 Electron 主进程（`desktop/electron/env.ts` 薄壳传入 `__dirname`）与 CLI 入口（`cli/src/index.ts` 的 `main()` 顶部）在启动最早期调用，确保子进程继承完整 PATH（覆盖 nvm / Homebrew / ~/.local/bin / workspace .bin）
- **工具探测**：inspect adapters 使用 `packages/inspect/src/adapters/tool-bin.ts` 的 `resolveToolCommand()` 做 PATH + node_modules/.bin 二级解析
- **路径拼接安全（防路径穿越 CWE-22）**：任何拼接可能涉及外部/不可信片段（用户输入、HTTP 请求参数、文件名、仓库名、扫描目标等）的文件路径，必须使用 `@zh/shared` 的 `safeJoin(base, ...segments)` / `safeResolve(base, target)`，**禁止**直接用 `path.join` / `path.resolve` 拼接不可信片段。`safeJoin`/`safeResolve` 在目标逃出 `base` 时抛出 `PathTraversalError`。回归用例见各包 `src/__tests__/safe-path-regression.test.ts`；CI 巡检由 `packages/kernel/assets/semgrep/path-traversal.yml` 规则抽查（report-only）。
- **无新依赖**：不引入任何新的 npm 包，所有功能使用 Node.js 内置 API
