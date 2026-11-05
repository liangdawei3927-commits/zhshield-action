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
 * 用法: node scripts/check-injected-copies.mjs [--quiet]
 *   --quiet  一致时不打印成功行（供 pre-commit hook 用；不一致时输出不变）
 * 退出码: 0 一致 / 1 发现不同步
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
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

/**
 * 判断「签入的 dist 是否确实是当前 src 编译出来的」——**按内容，不按时间戳**。
 *
 * 为什么不能按 mtime：git checkout / stash / apply 会 bump 源文件 mtime，而产物内容
 * 并没有变。此时 mtime 比较会报「dist 落后 5000s」，但强制重建后逐字节比对显示
 * dist 与 src 完全一致 —— 纯假警报。更糟的是它会训练人忽略这条提醒，
 * 真正「dist 缺文件」时反而被一起无视（2026-11-04 实测）。
 *
 * 做法：用 tsc 把当前 src 编译到临时目录，再与当前 dist 比内容。
 * 只有内容真的不一致才算「过期」—— 判据从「猜」变成「实测」。
 *
 * ⚠️ 比对方向必须是「**src 有而 dist 没有**」（missing from dist），不是反向。
 * dist 里多出来的文件是**本地构建残留**（源文件已删、产物没清），对下游无害：
 * 下游只按需 import，多余文件不会被加载。反过来漏掉的文件才是真事故 ——
 * 「新增的模块没有产物」正是 Cannot find module 的根因。
 */
function distMatchesSrc(pkgDir) {
  const srcDir = path.join('packages', pkgDir, 'src');
  const distDir = path.join('packages', pkgDir, 'dist');
  if (!fs.existsSync(srcDir) || !fs.existsSync(distDir)) return null; // 判不了，不报警
  const tsconfig = path.join('packages', pkgDir, 'tsconfig.json');
  if (!fs.existsSync(tsconfig)) return null;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `zhcs-${pkgDir}-`));
  try {
    // --outDir 覆盖 tsconfig 里的 outDir；composite 关掉以免写 tsbuildinfo 到源目录。
    execFileSync(
      'npx',
      [
        'tsc',
        '-p',
        tsconfig,
        '--outDir',
        tmpDir,
        '--composite',
        'false',
        '--declaration',
        'false',
        '--declarationMap',
        'false',
      ],
      { cwd: process.cwd(), stdio: 'pipe', timeout: 300000 },
    );
  } catch {
    // 编译不过（存量类型错误等）→ 判不了，不报警 —— 编译错误由 typecheck 门禁负责。
    return null;
  }

  // 只比对 .js（.d.ts/.map 由声明/映射策略决定，跨包可能合法不同）
  const jsFiles = (dir) => listFiles(dir).filter((f) => f.endsWith('.js'));
  const tmpJs = new Set(jsFiles(tmpDir));
  const distJs = new Set(jsFiles(distDir));
  // src 编译得出、但 dist 里没有 ⇒ 产物缺失，下游 import 会炸
  const missing = [...tmpJs].filter((f) => !distJs.has(f));
  if (missing.length > 0) return { status: 'missing', missing };
  const changed = [...tmpJs].filter((f) => {
    try {
      return (
        fs.readFileSync(path.join(distDir, f)).toString() !==
        fs.readFileSync(path.join(tmpDir, f)).toString()
      );
    } catch {
      return false;
    }
  });
  if (changed.length > 0) return { status: 'changed', changed };
  return { status: 'ok' };
}

/** 受校验的两棵树：types 走 src、运行时代码走 dist，缺任一棵都会造成假象 */
const TREES = ['src', 'dist'];

if (!fs.existsSync('packages')) {
  console.error('✗ 当前目录没有 packages/ —— 本脚本必须在仓库根目录运行');
  console.error('  （在别处运行会「检查 0 个副本」并误报一致，等于没查）');
  process.exit(1);
}

const pkgs = fs.readdirSync('packages');
const checked = new Set(); // 同一副本只检查一次（多个消费者共享）
const problems = [];
/** 源 dist 比源 src 旧（不阻断，只提醒先 build） */
const staleDists = new Map();
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

    // 附加提醒（不阻断）：签入的 dist 与当前 src 编译结果不一致 ⇒ 下游跑测试/构建会用到过期产物。
    // 2026-11-04 实锤：这条不提醒时，`dist` 缺文件要等 desktop 的 vitest 起不来才暴露，
    // 且报错是 "Cannot find module './xxx'"，完全不指向真因。
    //
    // 判据是**内容比对**（tsc 重编译后逐文件 diff），不是 mtime —— 见 distMatchesSrc 的说明。
    if (!staleDists.has(pkgDir)) {
      const verdict = distMatchesSrc(pkgDir);
      if (verdict && verdict.status !== 'ok') {
        staleDists.set(pkgDir, { consumer: pkg, verdict });
      }
    }
  }
}

if (checkedCount === 0) {
  console.error('✗ 未发现任何 pnpm 注入副本 —— node_modules 可能未安装，本次校验实际未生效');
  process.exit(1);
}

if (staleDists.size > 0) {
  console.error(
    '⚠️  以下包的签入 dist 与当前 src 编译结果不一致（下游会用到过期产物，改完记得 pnpm --filter <pkg> build）：',
  );
  for (const [pkgDir, info] of staleDists) {
    const v = info.verdict;
    const detail =
      v.status === 'missing'
        ? `dist 缺少 ${v.missing.length} 个产物（如 ${v.missing.slice(0, 2).join(', ')}）`
        : `dist 有 ${v.changed.length} 个文件内容不同`;
    console.error(`    packages/${pkgDir}（${detail}，消费者 ${info.consumer}）`);
  }
}

if (problems.length === 0) {
  // --quiet：供 pre-commit hook 调用，一致时不刷屏（不一致时的输出照旧，不为静默而静默）
  if (!process.argv.includes('--quiet')) {
    console.log(`✓ 注入副本与源 src/dist 一致（已检查 ${checkedCount} 个注入副本）`);
  }
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
