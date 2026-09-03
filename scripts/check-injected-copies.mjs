#!/usr/bin/env node
/**
 * check-injected-copies.mjs — 校验 pnpm 注入副本与源 dist 是否同步
 *
 * 背景（已踩三次的事故）：
 *   pnpm 对 `file:` 目录依赖（本仓库 @zh/* 全部如此）生成的是「实体副本」而非符号链接，
 *   位于 node_modules/.pnpm/@zh+<name>@file+packages+<dir>_<peer-hash>/node_modules/@zh/<name>。
 *   已存在的文件会随源码更新，但**新增的文件永远不会自动出现**在副本里
 *   （`pnpm install` / `--force` 均返回 Already up to date，无效）。
 *   后果：下游包 require 新模块时抛 "Cannot find module './xxx'"，
 *   报错完全不指向真因，极易误判为代码缺陷。
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

/** 递归列出目录下所有文件（相对路径，posix 分隔符，已排序） */
function listFiles(dir) {
  const out = [];
  const walk = (rel) => {
    const abs = rel ? path.join(dir, rel) : dir;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${e.name}` : e.name;
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

    const src = path.join('packages', pkgDir, 'dist');
    if (!fs.existsSync(src)) continue; // 源包尚未构建
    const copy = path.join(real, 'dist');

    checkedCount++;

    if (!fs.existsSync(copy)) {
      problems.push({ pkgDir, consumer: pkg, missing: [`(副本缺少整个 dist/ 目录)`] });
      continue;
    }

    const srcFiles = listFiles(src);
    const copyFiles = new Set(listFiles(copy));
    const missing = srcFiles.filter((f) => !copyFiles.has(f));
    if (missing.length > 0) problems.push({ pkgDir, consumer: pkg, missing });
  }
}

if (problems.length === 0) {
  console.log(`✓ 注入副本与源 dist 一致（已检查 ${checkedCount} 个注入副本）`);
  process.exit(0);
}

console.error(`✗ ${problems.length} 个包的注入副本不同步：`);
for (const p of problems) {
  console.error(
    `\n  packages/${p.pkgDir}（消费者 ${p.consumer}）缺少 ${p.missing.length} 个文件：`,
  );
  for (const f of p.missing.slice(0, 5)) console.error(`    - ${f}`);
  if (p.missing.length > 5) console.error(`    … 另有 ${p.missing.length - 5} 个`);
}
console.error('\n修复：rm -rf packages/<消费者包>/node_modules && pnpm install --prefer-offline');
console.error('      或重跑 bash scripts/verify-env.sh（完整链路，含副本刷新）');
process.exit(1);
