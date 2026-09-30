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
 * 同类故障的**类型层**表现（本脚本早期只同步 dist 的 .js，故遗漏）：
 *   各 @zh/* 包的 package.json 把 types / exports["."].types 指向 ./src/index.ts，
 *   即消费方（@zh/desktop）对 @zh/pipeline 做类型检查时读的是 pipeline **源码**，
 *   并沿其 import 链从 .pnpm 快照里取 @zh/guard、@zh/inspect 等 —— 取到的却是残缺副本。
 *   缺文件时该包自身 typecheck 正常（它用真实 packages/<pkg>/src），但跨包的 desktop
 *   会报 TS2345「X not assignable to Adapter」：基类（新增的 ScanAdapter 等）解析不到，
 *   类型退化为不可赋值。故 src 子树与 .d.ts 同样必须补链。
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

/**
 * 需要与源保持一致的子树及各子树的文件类型。
 * src —— types 指向 ./src/index.ts，消费方跨包类型检查会读到快照里的源码；
 * dist —— 运行时 require 入口，且 .d.ts 缺失同样会让跨包类型检查失败。
 */
const SYNC_SUBTREES = [
  { dir: 'src', extRe: /\.(ts|tsx|mts|cts)$/ },
  { dir: 'dist', extRe: /\.(js|cjs|mjs|d\.ts|map)$/ },
];

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
  ? fs
      .readdirSync(PACKAGES_DIR)
      .filter((n) => fs.statSync(path.join(PACKAGES_DIR, n)).isDirectory())
  : [];

for (const pkg of pkgNames) {
  const snapshots = findSnapshots(pkg).filter((d) => !isSymlink(d));
  if (snapshots.length === 0) continue; // 无复制型快照（可能是纯软链包，天然同步）

  for (const { dir, extRe } of SYNC_SUBTREES) {
    const srcRoot = path.join(PACKAGES_DIR, pkg, dir);
    if (!fs.existsSync(srcRoot)) continue;

    for (const snap of snapshots) {
      const snapRoot = path.join(snap, dir);
      if (!fs.existsSync(snapRoot)) continue;
      const files = [];
      const walk = (rel) => {
        const abs = path.join(srcRoot, rel);
        for (const entry of fs.readdirSync(abs)) {
          const relPath = path.join(rel, entry);
          const full = path.join(abs, entry);
          if (fs.statSync(full).isDirectory()) walk(relPath);
          else if (extRe.test(entry)) files.push(relPath);
        }
      };
      walk('.');
      for (const rel of files) {
        const srcFile = path.join(srcRoot, rel);
        const dstFile = path.join(snapRoot, rel);
        if (fs.existsSync(dstFile)) continue;
        anyMissing = true;
        if (CHECK_ONLY) {
          console.log(`[${pkg}] ${dir}/${rel} MISSING in snapshot`);
          continue;
        }
        const res = linkFile(srcFile, dstFile);
        if (res === 'linked') linked++;
        else if (res === 'copied') copied++;
        else console.error(`[${pkg}] ❌ 补链失败 ${dir}/${rel}: ${res}`);
        console.log(
          `[${pkg}] ${res === 'linked' ? '补链' : res === 'copied' ? '复制' : '❌'} ${dir}/${rel}`,
        );
      }
    }
  }
}

if (CHECK_ONLY) {
  if (anyMissing) {
    console.error('存在快照缺失（如上）。运行本脚本(不带 --check)以补链。');
    process.exit(1);
  }
  console.log('✅ 所有 workspace 包快照的 src/dist 已与源一致。');
} else if (linked + copied === 0) {
  console.log('✅ 无需补链：所有 workspace 包快照的 src/dist 已与源同步。');
} else {
  console.log(`✅ 补链完成：硬链 ${linked}，复制 ${copied}。`);
}
