// @ts-check
/**
 * Build the zhshield CLI into a self-contained single file.
 *
 * Why bundle: the published CLI must run in a clean environment (e.g. a CI
 * runner via `npx zhshield`) without the monorepo source tree. esbuild inlines
 * every @zh/* workspace package so the published @zh/cli is self-contained.
 *
 * Externalized:
 *  - Node built-ins (esbuild handles this for platform: 'node')
 *  - Third-party CLI binaries invoked via child_process (eslint, gitleaks,
 *    semgrep, depcruise, jscpd, ts-prune, depcheck, trivy) — these are strings
 *    passed to execFile, never imported, so esbuild leaves them out naturally.
 */
import { build } from 'esbuild';
import { resolve, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');

// 工作区包说明符：@zh/<pkg> 或 @zh/<pkg>/<subpath>（模块级常量避免每次 onResolve 重复编译）
const ZH_SPEC_RE = /^@zh\//;

// 把 @zh/* 工作区包直接解析到其 src/index.ts（而非 dist）。
// 原因：packages 的 package.json 通过 exports.require 指向 ./dist/index.js，
// 若只改源码而不重新构建每个包的 dist，bundle 会打进过期代码（曾导致
// buildFindings is not a function）。从源码打包可彻底消除该隐患，且 esbuild
// 原生转译 TS，等价且更可靠。
const zhSourcePlugin = {
  name: 'zh-source',
  setup(b) {
    b.onResolve({ filter: ZH_SPEC_RE }, (args) => {
      const spec = args.path.slice('@zh/'.length); // 'reporter' 或 'shared/foo'
      const [pkg, ...rest] = spec.split('/');
      const rel = rest.length ? join('src', ...rest) : 'src/index.ts';
      return { path: resolve(pkgRoot, '..', pkg, rel) };
    });
  },
};

const buildOptions = {
  entryPoints: [resolve(pkgRoot, 'src/index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: resolve(pkgRoot, 'dist/zhshield.js'),
  sourcemap: true,
  plugins: [zhSourcePlugin],
  absWorkingDir: pkgRoot,
};

/**
 * 源码指纹：把**实际参与打包的源文件**（esbuild metafile 的 inputs，排除 node_modules）
 * 按路径排序后逐个取 sha256，再汇总成一个哈希。
 *
 * 为什么需要它（代码审查报告3 §5.3）：`dist/zhshield.js` 是**提交进仓库**的产物
 * （GitHub Action 直装依赖它）。一旦有人改了 src 却没重新 build，仓库里躺着的就是
 * 一个"和源码对不上"的 bundle —— 用户（GitHub Action / npx）跑的就是旧代码，
 * 而 `pnpm test` 用 src 跑、永远绿。这类事故此前只能靠人肉记得"改完要 build"。
 *
 * 指纹只取决于**文件内容**，与构建平台无关，因此可以在 ubuntu 的 CI 上校验
 * 在 macOS 上构建并提交的产物（直接比对 bundle 文件内容会因平台差异误报）。
 */
async function computeSourceHash() {
  const probe = await build({ ...buildOptions, metafile: true, write: false, logLevel: 'silent' });
  const inputs = Object.keys(probe.metafile?.inputs ?? {})
    .filter((p) => !p.includes(`${sep}node_modules${sep}`) && !p.startsWith('node_modules/'))
    .map((p) => p.split(sep).join('/'))
    .sort();
  if (inputs.length === 0) throw new Error('[build] metafile 未返回任何输入文件，源码指纹不可信');
  const outer = createHash('sha256');
  for (const rel of inputs) {
    const abs = resolve(pkgRoot, rel);
    const inner = createHash('sha256').update(readFileSync(abs)).digest('hex');
    outer.update(`${rel}\u0000${inner}\n`);
  }
  return { hash: outer.digest('hex').slice(0, 16), fileCount: inputs.length };
}

const { hash: srcHash, fileCount } = await computeSourceHash();

await build({
  ...buildOptions,
  banner: {
    js: [
      '#!/usr/bin/env node',
      `// @zh-src-hash: ${srcHash}`,
      `// @zh-src-files: ${fileCount}`,
      '// 校验：pnpm --filter zhshield-cli verify:dist-fresh（改了 src 必须重建并提交本文件）',
    ].join('\n'),
  },
  logLevel: 'info',
});

// SOP 规则以文件系统目录形式被运行时加载（非 import），esbuild 不会自动打包。
// 必须随 bundle 复制到 dist/sop，否则干净容器（无 monorepo 源码）下规则加载失败。
const sopSrc = resolve(pkgRoot, '..', 'kernel', 'src', 'sop');
const sopDst = resolve(pkgRoot, 'dist', 'sop');
if (existsSync(sopSrc)) {
  rmSync(sopDst, { recursive: true, force: true });
  mkdirSync(sopDst, { recursive: true });
  cpSync(sopSrc, sopDst, { recursive: true });
  console.log(`[build] SOP rules copied: ${sopSrc} -> ${sopDst}`);
} else {
  console.warn(`[build] SOP rules source not found, skipped: ${sopSrc}`);
}
