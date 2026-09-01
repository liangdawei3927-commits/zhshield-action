// @ts-check
/**
 * 校验 packages/cli/dist/sop 与 packages/kernel/src/sop 是否同步。
 *
 * 背景:build-cli.mjs 在构建时把 kernel/src/sop 递归拷贝到 dist/sop,
 * 而 dist/ 是入库的编译产物,与 kernel 源码构成双源。若只改 kernel 源码
 * 而不重新构建 CLI,dist/sop 会携带过期规则,导致发布包与源码漂移。
 * 本脚本逐文件比对两侧内容 hash 与文件清单,不一致时以退出码 1 暴露漂移。
 *
 * 用法:node scripts/verify-sop-sync.mjs
 * 退出码:0 = 同步;1 = 存在漂移或目录缺失。
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

// 用 import.meta.dirname 相对定位仓库根,不依赖运行时 cwd。
// scripts/ -> cli -> packages -> 仓库根
const repoRoot = resolve(import.meta.dirname, '..', '..', '..');
const sopSrc = join(repoRoot, 'packages', 'kernel', 'src', 'sop');
const sopDst = join(repoRoot, 'packages', 'cli', 'dist', 'sop');

/** 递归收集目录下所有文件的相对路径(按路径排序)。只收集文件,忽略目录属性。 */
function collectFiles(dir) {
  const files = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        files.push(relative(dir, full));
      }
    }
  };
  walk(dir);
  return files.sort();
}

/** 计算单个文件的 SHA-256 摘要。 */
function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/** 收集目录内每个文件的相对路径 -> SHA-256。 */
function snapshot(dir) {
  const map = new Map();
  for (const rel of collectFiles(dir)) {
    map.set(rel, sha256(join(dir, rel)));
  }
  return map;
}

function main() {
  if (!statSync(sopSrc, { throwIfNoEntry: false })?.isDirectory()) {
    console.error(`[verify-sop] 源码目录不存在:${sopSrc}`);
    process.exit(1);
  }
  if (!statSync(sopDst, { throwIfNoEntry: false })?.isDirectory()) {
    console.error(`[verify-sop] dist 目录不存在(请先构建):${sopDst}`);
    process.exit(1);
  }

  const src = snapshot(sopSrc);
  const dst = snapshot(sopDst);
  const drifted = [];

  // 仅存在于源码侧(未拷贝到 dist)
  for (const rel of src.keys()) {
    if (!dst.has(rel)) drifted.push(`仅存在于 kernel/src/sop:${rel}`);
  }
  // 仅存在于 dist 侧(源码已删除但 dist 残留)
  for (const rel of dst.keys()) {
    if (!src.has(rel)) drifted.push(`仅存在于 dist/sop:${rel}`);
  }
  // 两侧都有但内容 hash 不一致
  for (const rel of src.keys()) {
    if (dst.has(rel) && src.get(rel) !== dst.get(rel)) {
      drifted.push(`内容不一致:${rel}`);
    }
  }

  if (drifted.length > 0) {
    console.error(`[verify-sop] 检测到 ${drifted.length} 个漂移文件:`);
    for (const line of drifted) console.error(`  - ${line}`);
    console.error('[verify-sop] 请重新构建 CLI(pnpm --filter zhshield-cli build)以同步 dist/sop。');
    process.exit(1);
  }

  console.log(`dist/sop 与 kernel/src/sop 同步 OK(${src.size} 个文件)`);
}

main();
