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
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');

// 把 @zh/* 工作区包直接解析到其 src/index.ts（而非 dist）。
// 原因：packages 的 package.json 通过 exports.require 指向 ./dist/index.js，
// 若只改源码而不重新构建每个包的 dist，bundle 会打进过期代码（曾导致
// buildFindings is not a function）。从源码打包可彻底消除该隐患，且 esbuild
// 原生转译 TS，等价且更可靠。
const zhSourcePlugin = {
  name: 'zh-source',
  setup(b) {
    b.onResolve({ filter: /^@zh\// }, (args) => {
      const spec = args.path.slice('@zh/'.length); // 'reporter' 或 'shared/foo'
      const [pkg, ...rest] = spec.split('/');
      const rel = rest.length ? join('src', ...rest) : 'src/index.ts';
      return { path: resolve(pkgRoot, '..', pkg, rel) };
    });
  },
};

await build({
  entryPoints: [resolve(pkgRoot, 'src/index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: resolve(pkgRoot, 'dist/zhshield.js'),
  banner: { js: '#!/usr/bin/env node' },
  sourcemap: true,
  plugins: [zhSourcePlugin],
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
