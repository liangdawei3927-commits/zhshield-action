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

const child = spawn(
  process.execPath,
  ['--import', 'tsx', entry, ...process.argv.slice(2)],
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
