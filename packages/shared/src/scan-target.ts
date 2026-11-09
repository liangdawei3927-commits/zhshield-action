/**
 * 源码扫描的目标目录解析（semgrep / dep-cruiser 等"扫一棵源码树"的工具通用）。
 *
 * **为什么不能直接扫项目根**：项目根里不只有源码 —— 还有 `.git`、构建产物、
 * 报告输出目录、锁文件、二进制资源。扫它们既慢又会自触发误报。
 * 真正的源码通常在 `src/`（单包）或 `packages/`（monorepo）下。
 *
 * **实测代价（2026-11-04 A14 复测）**：
 *   · 目标 = 仓库根（带 9 个 exclude）：semgrep 单次 14.8s
 *   · 目标 = `packages/`（同样带 exclude）：semgrep 单次 3.6s
 * 同一份规则、同一台机器，只因目标从源码树退化成仓库根就慢 4 倍。
 * security 域的 semgrep 适配器曾直接用 projectPath 当目标（inspect 侧却有
 * 正确的解析逻辑），两边行为分叉 —— 故收敛到此处，两侧共用。
 *
 * 解析顺序（与 inspect 侧原有实现逐项一致，未改变其行为）：
 *   1. `<project>/src` 存在 → 用它（单包项目）
 *   2. `<project>/packages` 存在 → 用它（monorepo）
 *   3. 子目录里同时有 `package.json` 与 `packages/` → 用该子目录的 `packages`
 *      （被扫目标是 monorepo 的某个子目录时）
 *   4. 都判不出 → 回退项目根（宁可多扫，也不能不扫）
 *
 * **嵌套的独立仓库不参与第 3 条**（2026-11-09 实测事故）：被扫项目里可能放着一份
 * 被 `.gitignore` 排除的完整仓库（本仓的 `zhihui-codeshield/` 就是这种内外分离结构）。
 * 它有自己的 `.git`，是**另一个项目**，不是本项目的源码子目录；若按第 3 条钻进
 * 它的 `packages/`，等于拿别人的仓库当自己的源码扫 —— 实测把 120s 的安全域预算
 * 全部耗在它身上，扫描被杀、域判 `unavailable`，页面回落到旧报告显示 100 分。
 * 判据只看 `.git` 是否存在（哪怕是个 worktree）：宁可少扫嵌套仓库，也不能扫错对象。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export function resolveSourceScanTarget(projectPath: string): string {
  const root = path.resolve(projectPath);
  const srcDir = path.join(root, 'src');
  if (fs.existsSync(srcDir)) return srcDir;
  const packagesDir = path.join(root, 'packages');
  if (fs.existsSync(packagesDir)) return packagesDir;

  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'node_modules') continue;
      const child = path.join(root, entry.name);
      // 嵌套的独立仓库 = 另一个项目，不是本项目的源码树（见上方说明）
      if (fs.existsSync(path.join(child, '.git'))) continue;
      if (
        fs.existsSync(path.join(child, 'package.json')) &&
        fs.existsSync(path.join(child, 'packages'))
      ) {
        return path.join(child, 'packages');
      }
    }
  } catch {
    // 目录读取失败则回退项目根
  }
  return root;
}
