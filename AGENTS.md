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
