#!/usr/bin/env node
/**
 * check-injected-copies.mjs — 校验 pnpm 注入副本与源 src / dist 是否同步
 *
 * 背景（已踩三次的事故）：
 *   pnpm 对 `file:` 目录依赖（本仓库 @zh/* 全部如此）生成的是「实体副本」而非符号链接，
 *   位于 node_modules/.pnpm/@zh+<name>@file+packages+<dir>_<peer-hash>/node_modules/@zh/<name>。
 *   已存在的文件会随源码更新，但**新增的文件永远不会自动出现**在副本里
 *   （`pnpm install` / `--force` 均返回 Already up to date，无效）。
 *   后果：下游包 require 新模块时抛 "Cannot find module './xxx'"，
 *   报错完全不指向真因，极易误判为代码缺陷。
 *
 * 为什么要同时比对 src 与 dist：
 *   `@zh/*` 的 package.json `exports` 对 types 指向 `./src`、import/require 指向 `./dist`。
 *   只比 dist 会漏掉「新增 .ts 源文件 → 下游 tsc 报 TS2307」这一类事故
 *   （2026-11-02 实锤：deps-cve.ts 下沉 @zh/pipeline 后，副本只有 dist 被比对，
 *   脚本报「一致」，而 desktop 的 tsc 已经红灯）。两棵树缺一不可。
 *
 * 本脚本只检查「消费者实际解析到的副本」：
 *   - 遍历 packages/<pkg>/node_modules/@zh/<dep> 的软链并 realpath 解析
 *   - 只校验解析结果落在 node_modules/.pnpm/ 内的注入副本
 *     （解析到 packages/ 自身的是工作区直链，永远同步，跳过）
 *
 * 用法: node scripts/check-injected-copies.mjs
 * 退出码: 0 一致 / 1 发现不同步
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * 消费者不会 import 的路径：测试目录与 macOS 垃圾文件。
 * 把它们算进差异只会制造噪音（副本里没有 __tests__ 并不影响下游编译/运行），
 * 真出问题时是「新增的**被引用模块**缺失」，那类文件一定会落在这个过滤之外。
 */
const IGNORED_PATH = /^(?:__tests__\/|tests\/)|(?:^|\/)(?:\.DS_Store|\.gitkeep)$/;

/** 递归列出目录下所有文件（相对路径，posix 分隔符，已排序） */
function listFiles(dir) {
  const out = [];
  const walk = (rel) => {
    const abs = rel ? path.join(dir, rel) : dir;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (IGNORED_PATH.test(relPath)) continue;
      if (e.isDirectory()) walk(relPath);
      else if (e.isFile()) out.push(relPath);
    }
  };
  walk('');
  return out.sort();
}

/** 从注入副本真实路径推导源包目录名：@zh+kernel@file+packages+kernel_eslint@x → kernel */
function pkgDirFromCopy(realPath) {
  const m = realPath.match(/@zh\+[^@]+@file\+packages\+([^_/]+)/);
  return m ? m[1] : null;
}

/** 比对单棵树（src 或 dist），返回缺失文件列表（空数组 = 一致） */
function diffTree(pkgDir, real, tree) {
  const sourceDir = path.join('packages', pkgDir, tree);
  if (!fs.existsSync(sourceDir)) return { status: 'skip' };
  const copyDir = path.join(real, tree);
  if (!fs.existsSync(copyDir)) {
    return { status: 'missing-dir', missing: [`(副本缺少整个 ${tree}/ 目录)`] };
  }
  const sourceFiles = listFiles(sourceDir);
  const copyFiles = new Set(listFiles(copyDir));
  const missing = sourceFiles.filter((f) => !copyFiles.has(f));
  return { status: missing.length > 0 ? 'missing-files' : 'ok', missing };
}

/** 受校验的两棵树：types 走 src、运行时代码走 dist，缺任一棵都会造成假象 */
const TREES = ['src', 'dist'];

const pkgs = fs.existsSync('packages') ? fs.readdirSync('packages') : [];
const checked = new Set(); // 同一副本只检查一次（多个消费者共享）
const problems = [];
let checkedCount = 0;

for (const pkg of pkgs) {
  const depDir = path.join('packages', pkg, 'node_modules', '@zh');
  if (!fs.existsSync(depDir)) continue;

  for (const dep of fs.readdirSync(depDir)) {
    const link = path.join(depDir, dep);
    let real;
    try {
      real = fs.realpathSync(link);
    } catch {
      continue; // 断链，交给 install 处理
    }
    if (checked.has(real)) continue;
    checked.add(real);

    // 工作区直链（解析到 packages/ 自身）永远同步，跳过
    if (!real.includes(`${path.sep}node_modules${path.sep}.pnpm${path.sep}`)) continue;

    const pkgDir = pkgDirFromCopy(real);
    if (!pkgDir) continue;

    checkedCount++;
    for (const tree of TREES) {
      const result = diffTree(pkgDir, real, tree);
      if (result.status === 'skip' || result.status === 'ok') continue;
      problems.push({
        pkgDir,
        consumer: pkg,
        tree,
        missing: result.missing ?? [],
        wholeDir: result.status === 'missing-dir',
      });
    }
  }
}

if (problems.length === 0) {
  console.log(`✓ 注入副本与源 src/dist 一致（已检查 ${checkedCount} 个注入副本）`);
  process.exit(0);
}

console.error(`✗ ${problems.length} 处注入副本不同步：`);
for (const p of problems) {
  if (p.wholeDir) {
    console.error(`\n  packages/${p.pkgDir}（消费者 ${p.consumer}）缺少整个 ${p.tree}/ 目录`);
    continue;
  }
  console.error(
    `\n  packages/${p.pkgDir}（消费者 ${p.consumer}）${p.tree}/ 缺少 ${p.missing.length} 个文件：`,
  );
  for (const f of p.missing.slice(0, 5)) console.error(`    - ${f}`);
  if (p.missing.length > 5) console.error(`    … 另有 ${p.missing.length - 5} 个`);
}
console.error('\n修复：rm -rf packages/<消费者包>/node_modules && pnpm install --prefer-offline');
console.error('      或重跑 bash scripts/verify-env.sh（完整链路，含副本刷新）');
process.exit(1);
