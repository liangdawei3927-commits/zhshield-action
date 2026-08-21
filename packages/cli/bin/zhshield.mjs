#!/usr/bin/env node

/**
 * zhshield — 智汇码盾 CLI binary entry
 *
 * Delegates to tsx for TypeScript execution.
 */

import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const entry = resolve(__dirname, '..', 'src', 'index.ts');

// tsx 是 @zh/cli 的 devDependency，按包内 node_modules 解析为绝对路径，
// 避免 `--import tsx` 依赖当前工作目录解析（git hooks 在仓库根目录运行时无法命中）。
let tsxLoader = 'tsx';
try {
  tsxLoader = import.meta.resolve('tsx');
} catch {
  // 保持原行为兜底；tsx 缺失时 CLI 本就无法运行
}

const child = spawn(
  process.execPath,
  ['--import', tsxLoader, entry, ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    env: { ...process.env },
  },
);

child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});

process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
