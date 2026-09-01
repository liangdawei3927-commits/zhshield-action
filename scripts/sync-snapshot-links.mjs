#!/usr/bin/env node
/**
 * sync-snapshot-links.mjs — 补齐 pnpm workspace 快照缺失的产物文件硬链接。
 *
 * 背景（"Electron 打不开桌面端页面"的根因）：
 *   项目使用 node-linker=hoisted，pnpm 会把 workspace 包（@zh/*）以「硬链接镜像」的形式
 *   复制为 node_modules/.pnpm 下前缀 @zh+&lt;pkg&gt;@&ast; 的包目录，实际入口为 @zh/&lt;pkg&gt;。
 *   硬链接只在 pnpm install 时针对「当时已存在的文件」建立。若此后某 workspace 包新增了源文件
 *   （如新增 lockfile-utils.ts）并重新 tsc 构建，产生新的 dist 产物文件（lockfile-utils.js），
 *   该新文件在 .pnpm 快照中没有对应硬链接 —— 快照里却可能已有引用它的旧产物（graph-builder.js），
 *   于是 Electron 主进程 require @zh/dependency 时抛 `Cannot find module './lockfile-utils'`，
 *   主进程崩溃 → 窗口永不创建 → 页面打不开。
 *
 *   pnpm install --force 不会修复（锁文件未变时 pnpm 跳过硬链接重建）。
 *   本脚本在每次 build / dev 之后运行，为快照中「缺失」的产物文件补硬链接（失败回退复制），
 *   彻底消除该类"新增文件不同步"导致的运行时缺模块问题。
 *
 * 用法：node scripts/sync-snapshot-links.mjs [--check]
 *   --check：只校验并报告缺失，不实际补链；以非零退出码表示存在缺失（供 CI）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PACKAGES_DIR = path.join(ROOT, 'packages');
const PNPM_DIR = path.join(ROOT, 'node_modules', '.pnpm');

const CHECK_ONLY = process.argv.includes('--check');

const EXT_RE = /\.(js|cjs|mjs)$/;

/** 列出 @zh/<pkg> 的所有 .pnpm 快照主目录（可能因不同依赖上下文存在多个） */
function findSnapshots(pkg) {
  if (!fs.existsSync(PNPM_DIR)) return [];
  const results = [];
  for (const dirName of fs.readdirSync(PNPM_DIR)) {
    const m = dirName.match(/^@zh\+([^@]+)@/);
    if (!m || m[1] !== pkg) continue;
    const pkgDir = path.join(PNPM_DIR, dirName, 'node_modules', '@zh', pkg);
    if (fs.existsSync(pkgDir)) results.push(pkgDir);
  }
  return results;
}

/** 该包节点是否为「软链接」（指向源，天然同步，无需处理） */
function isSymlink(pkgDir) {
  return fs.lstatSync(pkgDir).isSymbolicLink();
}

function linkFile(srcPath, dstPath) {
  if (fs.existsSync(dstPath)) return 'exists';
  try {
    fs.linkSync(srcPath, dstPath); // 硬链接，与 install 时 pnpm 的行为一致
    return 'linked';
  } catch {
    try {
      fs.copyFileSync(srcPath, dstPath); // 跨设备等情况下回退为复制
      return 'copied';
    } catch (err) {
      return `failed(${err?.message ?? err})`;
    }
  }
}

let anyMissing = false;
let linked = 0;
let copied = 0;

const pkgNames = fs.existsSync(PACKAGES_DIR)
  ? fs.readdirSync(PACKAGES_DIR).filter((n) => fs.statSync(path.join(PACKAGES_DIR, n)).isDirectory())
  : [];

for (const pkg of pkgNames) {
  const srcDist = path.join(PACKAGES_DIR, pkg, 'dist');
  if (!fs.existsSync(srcDist)) continue;

  const snapshots = findSnapshots(pkg).filter((d) => !isSymlink(d));
  if (snapshots.length === 0) continue; // 无复制型快照（可能是纯软链包，天然同步）

  for (const snapDist of snapshots.map((d) => path.join(d, 'dist'))) {
    if (!fs.existsSync(snapDist)) continue;
    const files = [];
    const walk = (rel) => {
      const abs = path.join(srcDist, rel);
      for (const entry of fs.readdirSync(abs)) {
        const relPath = path.join(rel, entry);
        const full = path.join(abs, entry);
        if (fs.statSync(full).isDirectory()) walk(relPath);
        else if (EXT_RE.test(entry)) files.push(relPath);
      }
    };
    walk('.');
    for (const rel of files) {
      const srcFile = path.join(srcDist, rel);
      const dstFile = path.join(snapDist, rel);
      if (fs.existsSync(dstFile)) continue;
      anyMissing = true;
      if (CHECK_ONLY) {
        console.log(`[${pkg}] MISSING in snapshot: ${rel}`);
        continue;
      }
      const res = linkFile(srcFile, dstFile);
      if (res === 'linked') linked++;
      else if (res === 'copied') copied++;
      else console.error(`[${pkg}] ❌ 补链失败 ${rel}: ${res}`);
      console.log(`[${pkg}] ${res === 'linked' ? '补链' : res === 'copied' ? '复制' : '❌'} ${rel}`);
    }
  }
}

if (CHECK_ONLY) {
  if (anyMissing) {
    console.error('存在快照缺失（如上）。运行本脚本(不带 --check)以补链。');
    process.exit(1);
  }
  console.log('✅ 所有 workspace 包快照产物与源 dist 一致。');
} else if (linked + copied === 0) {
  console.log('✅ 无需补链：所有 workspace 包快照产物已与源 dist 同步。');
} else {
  console.log(`✅ 补链完成：硬链 ${linked}，复制 ${copied}。`);
}
