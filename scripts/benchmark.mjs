#!/usr/bin/env node
/**
 * 智汇码盾性能基准测试
 * 测量不同项目规模下的扫描时间基线
 * Usage: node scripts/benchmark.mjs [--project-path /path/to/project]
 */
import { execSync } from 'child_process';
import { performance } from 'perf_hooks';
import fs from 'fs';
import path from 'path';

const RESULTS = [];

function countLOC(dir) {
  let count = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory() && !['node_modules', 'dist', '.git', 'coverage', '.turbo'].includes(entry.name)) {
        count += countLOC(fullPath);
      } else if (entry.isFile() && /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) {
        count += fs.readFileSync(fullPath, 'utf-8').split('\n').length;
      }
    }
  } catch {}
  return count;
}

function runBenchmark(name, command, cwd) {
  console.log(`\n  Running: ${name}`);
  const start = performance.now();
  try {
    execSync(command, { cwd, stdio: 'pipe', timeout: 300000 });
    const elapsed = Math.round(performance.now() - start);
    RESULTS.push({ name, elapsed, status: 'success' });
    console.log(`    ${elapsed}ms`);
  } catch (err) {
    const elapsed = Math.round(performance.now() - start);
    RESULTS.push({ name, elapsed, status: 'failed', error: String(err.message).slice(0, 100) });
    console.log(`    ${elapsed}ms (failed)`);
  }
}

const projectPath = process.argv.includes('--project-path')
  ? process.argv[process.argv.indexOf('--project-path') + 1]
  : process.cwd();

console.log('Benchmark: ZHCodeShield');
console.log(`Project: ${projectPath}`);
const loc = countLOC(projectPath);
console.log(`LOC: ${loc.toLocaleString()}`);

runBenchmark('ESLint', 'npx eslint "packages/*/src/**/*.{ts,tsx}" --quiet', projectPath);
runBenchmark('TypeScript Check', 'npx tsc --noEmit', projectPath);
runBenchmark('Vitest Tests', 'pnpm test', projectPath);

console.log('\nResults:');
for (const r of RESULTS) {
  console.log(`  ${r.status === 'success' ? 'OK' : 'FAIL'} ${r.name}: ${r.elapsed}ms`);
}
const total = RESULTS.reduce((s, r) => s + r.elapsed, 0);
console.log(`  Total: ${total}ms (${(total / 1000).toFixed(1)}s)`);

const outputDir = path.join(projectPath, '.zhshield');
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, 'benchmark-results.json'), JSON.stringify({ timestamp: new Date().toISOString(), loc, results: RESULTS }, null, 2));
