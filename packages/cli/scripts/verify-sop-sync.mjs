// @ts-check
/**
 * 校验 packages/cli/dist/sop 与 packages/kernel/src/sop 是否同步。
 *
 * 背景：build-cli.mjs 构建时把 kernel/src/sop 递归拷到 dist/sop，而 dist/ 是入库的
 * 发布产物（Action 门禁直接取它），与 kernel 源码构成双源。若只改源码不重建 CLI，
 * dist/sop 会携带过期规则 → 发布包与源码漂移。
 *
 * ⚠️ 调用时机决定这条门禁是否有效：**必须在 Build 之前跑**。
 * build-cli.mjs 会先 rm -rf dist/sop 再 cp -r 重建，若本校验排在其后，
 * 比较对象变成"刚刚重新生成的产物"，结构上永不红（2026-10-25 实测：
 * 提交里的 dist/sop 已漂移而 CI 仍绿，正是这个顺序造成的）。
 *
 * 用法：node scripts/verify-sop-sync.mjs
 * 退出码：0 = 同步；1 = 存在漂移、目录缺失或源码目录为空。
 */
import { resolve } from 'node:path';

import { compareSopTrees, describeSopSyncProblems } from './sop-sync-compare.mjs';

// 用 import.meta.dirname 相对定位，不依赖运行时 cwd。
// scripts/ -> cli -> packages -> 仓库根
const repoRoot = resolve(import.meta.dirname, '..', '..', '..');
const sopSrc = resolve(repoRoot, 'packages', 'kernel', 'src', 'sop');
const sopDst = resolve(repoRoot, 'packages', 'cli', 'dist', 'sop');

const result = compareSopTrees(sopSrc, sopDst);

if (!result.ok) {
  const problems = describeSopSyncProblems(result);
  console.error(`[verify-sop] 检测到 ${problems.length} 处问题:`);
  for (const line of problems) console.error(`  - ${line}`);
  console.error('[verify-sop] 请重新构建 CLI（pnpm --filter zhshield-cli build）以同步 dist/sop。');
  process.exit(1);
}

console.log(`dist/sop 与 kernel/src/sop 同步 OK(${result.checked} 个文件)`);
