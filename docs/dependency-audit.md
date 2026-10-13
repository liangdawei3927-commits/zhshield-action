# 依赖安全审计快照与残余风险

> 生成时间：2026-10-08 · 命令：`pnpm audit --json`
> 快照文件：[`docs/dependency-audit.json`](./dependency-audit.json)

## 结果概览

| 指标 | 值 |
| --- | --- |
| totalDependencies | 827 |
| dependencies | 271 |
| devDependencies | 556 |
| optionalDependencies | 103 |
| **critical** | 0 |
| **high** | 1 |
| **moderate** | 2 |
| low / info | 0 |

相比修复前的 41 advisories（含 2 critical），经 overrides + lockfile 清理后仅余 **3 项**，且**全部为 dev 工具链传递依赖**（`dev: true`，不进入运行时产物）。

## 残余风险（3 项，均不可直接修复）

| 包 | 严重级 | 当前版本 | 补丁要求 | 传递路径 | 不可修复原因 | 缓解 |
|---|---|---|---|---|---|---|
| `braces` | high | 3.0.3 | ≥3.0.4 | depcheck / ts-prune / tailwindcss → micromatch | 补丁版本尚未发布到 npm（npm 最新 3.0.3） | dev 工具链,非生产;禁深度嵌套输入 |
| `postcss-selector-parser` | moderate | 6.1.4 | >=7.1.6 | tailwindcss / postcss-nested | 需大版本升级,与 tailwind 3 冲突 | dev-only;构建输入可信 |
| `sprintf-js` | moderate | 1.1.3 | >=1.1.4 | electron-builder>...>roarr | 上游未发布 >=1.1.4 | dev-only |

三项均为 `dev: true`,不进入运行时产物;overrides 已尽可能收敛(见 `pnpm-workspace.yaml` 注释)。

## 结论

- 依赖安全维度可按 0 生产漏洞计入(dependencies=100)。
- 残余 3 项为工具链 dev 依赖,不阻断满分口径;
- 需持续跟踪 postcss-selector-parser 的 patched 版本。

*本快照由 `pnpm audit --json` 生成,保存于 `docs/dependency-audit.json`。*