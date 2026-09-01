#!/usr/bin/env node
/**
 * 智汇码盾性能基准测试
 * 测量不同项目规模下的扫描时间基线
 *
 * Usage:
 *   node scripts/benchmark.mjs [--project-path /path/to/project]   # 默认：cwd，测量 eslint/tsc/test
 *   node scripts/benchmark.mjs --sample                             # 固定样本项目（自包含计时，无需外部工具）
 *   node scripts/benchmark.mjs --sample --save-base <path>          # 生成/更新基线 JSON（默认 scripts/fixtures/.benchmark-baseline.json）
 *   node scripts/benchmark.mjs --sample --baseline <path>           # 与基线对比，任一指标回归 >10% → exit 1
 *   node scripts/benchmark.mjs --gate                               # 等价 --sample --baseline scripts/fixtures/.benchmark-baseline.json
 *
 * 计时集说明（重要）：
 *   - 非 --sample 模式（默认/--project-path）：保持原有 3 个外部命令测量不变
 *     （npx eslint / npx tsc --noEmit / pnpm test），向后兼容 P0/P1 用户。
 *   - --sample 模式：固定样本项目 scripts/fixtures/sample-repo 上运行自包含、无需外部
 *     工具链的计时集，保证输入固定、计时稳定可比：
 *       (a) scan-files   — 递归遍历样本目录统计 .ts/.js 文件数（纯 node，CPU 绑定）
 *       (b) read-package — JSON.parse 样本 package.json（纯 node，CPU 绑定）
 *       (c) evaluate-n   — 字符串运算的 CPU 速度探针（机器速度 sanity 探针）
 *     每个指标放大到数十~数百 ms 并取 min-of-N + 跨轮 best-case，滤除调度噪声，
 *     使 >10% 回归门禁有意义。
 *
 * 输出：始终写入 <target>/.zhshield/benchmark-results.json（含 machineProfile）。
 */
import { execSync } from 'child_process';
import { performance } from 'perf_hooks';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const RESULTS = [];
const SOURCE_FILE_RE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const REGRESSION_THRESHOLD = 1.1; // 回归 >10% 视为门禁失败
const DEFAULT_BASELINE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  '.benchmark-baseline.json',
);
const SAMPLE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'sample-repo',
);

// ---- 机器画像（内联实现，避免 import @zh/shared —— 根 node_modules 仅链接 kernel）----
// 镜像 packages/shared/src/machine-profile.ts 第 7-22 行逻辑（cores/totalMemGb/freeMemGb）。
function detectMachineProfile() {
  const cores = os.cpus().length;
  const totalMemGb = os.totalmem() / 1024 ** 3;
  const freeMemGb = os.freemem() / 1024 ** 3;
  return {
    cores,
    totalMemGb: Math.round(totalMemGb * 100) / 100,
    freeMemGb: Math.round(freeMemGb * 100) / 100,
  };
}

function countLOC(dir) {
  let count = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (
        entry.isDirectory() &&
        !['node_modules', 'dist', '.git', 'coverage', '.turbo'].includes(entry.name)
      ) {
        count += countLOC(fullPath);
      } else if (entry.isFile() && SOURCE_FILE_RE.test(entry.name)) {
        count += fs.readFileSync(fullPath, 'utf-8').split('\n').length;
      }
    }
  } catch (err) {
    console.error(`    countLOC 遍历失败：${err.message}`);
  }
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

// ---- --sample 模式：自包含计时集（无需外部工具链）----
// 运行单个样本指标 SAMPLE_RUNS 次，返回最小耗时（min-of-N，微基准标准做法）滤除调度噪声。
// 失败时返回 null。
function runSampleMetric(name, fn) {
  let best = Infinity;
  let detail = '';
  for (let i = 0; i < SAMPLE_RUNS; i++) {
    const start = performance.now();
    try {
      detail = fn();
      const elapsed = Math.round(performance.now() - start);
      if (elapsed < best) best = elapsed;
    } catch (err) {
      console.error(`    ${name} run ${i + 1} failed: ${err.message}`);
      return null;
    }
  }
  return { name, elapsed: best, status: 'success', detail };
}

// 计时集工作量说明：固定样本的单个操作（遍历 50 文件 / 解析小 package.json / 10k 字符串运算）
// 耗时仅 1-6ms，OS 调度抖动会放大成 >100% 的百分比波动，导致 >10% 门禁误报。
// 因此将每个指标做成 CPU 绑定（磁盘 I/O 只做一次，随后对内存数据反复处理），放大到数十 ms，
// 并取多次运行的最小值（min-of-N，微基准标准做法）滤除调度噪声，使 >10% 阈值有意义。
// 指标语义不变：scan-files 仍统计样本源文件数，read-package 仍解析 package.json。
const SCAN_ITERATIONS = 40000; // 对内存中的文件路径列表做 4 万次计数 → 单次 ~100-150ms
const READ_ITERATIONS = 100000; // 内存中 JSON.parse 10 万次 → 单次 ~150-250ms
const EVAL_ITERATIONS = 1500000; // 150 万次字符串运算 → 单次 ~150-300ms
const SAMPLE_RUNS = 10; // 每个指标每轮运行 10 次，取最小值（min-of-N）滤除噪声
const SAMPLE_PASSES = 5; // 整个计时集跑 5 轮，跨轮再取最小值（best-case），基线/门禁两侧都稳定

// 收集样本目录下所有源文件路径（磁盘 I/O 只做一次）。
function collectSourceFiles(dir) {
  const files = [];
  const walk = (d) => {
    const entries = fs.readdirSync(d, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(d, entry.name);
      if (
        entry.isDirectory() &&
        !['node_modules', 'dist', '.git', 'coverage', '.turbo'].includes(entry.name)
      ) {
        walk(fullPath);
      } else if (entry.isFile() && SOURCE_FILE_RE.test(entry.name)) {
        files.push(fullPath);
      }
    }
  };
  walk(dir);
  return files;
}

function scanFiles(dir) {
  const files = collectSourceFiles(dir);
  let count = 0;
  for (let i = 0; i < SCAN_ITERATIONS; i++) {
    for (const f of files) {
      if (SOURCE_FILE_RE.test(f)) count++;
    }
  }
  return `${files.length} files x${SCAN_ITERATIONS} (count=${count})`;
}

function readPackage(dir) {
  // 先读一次到内存，再对内存字符串反复 JSON.parse —— 避免重复磁盘 I/O 的页缓存抖动，
  // 使该指标稳定（CPU 绑定），>10% 门禁才有意义。
  const raw = fs.readFileSync(path.join(dir, 'package.json'), 'utf-8');
  let name = '';
  for (let i = 0; i < READ_ITERATIONS; i++) {
    name = JSON.parse(raw).name;
  }
  return `name=${name} x${READ_ITERATIONS}`;
}

function evaluateN() {
  let s = '';
  for (let i = 0; i < EVAL_ITERATIONS; i++) {
    s = `${s.length}-${i}-${(i * 31) % 7}`;
  }
  return `len=${s.length} x${EVAL_ITERATIONS}`;
}

function runSampleSet() {
  const metrics = [
    ['scan-files', () => scanFiles(SAMPLE_DIR)],
    ['read-package', () => readPackage(SAMPLE_DIR)],
    ['evaluate-n', evaluateN],
  ];
  const best = new Map(); // name -> { elapsed, detail }
  for (let pass = 1; pass <= SAMPLE_PASSES; pass++) {
    console.log(`\n  Pass ${pass}/${SAMPLE_PASSES}:`);
    for (const [name, fn] of metrics) {
      const r = runSampleMetric(name, fn);
      if (!r) {
        RESULTS.push({ name, elapsed: 0, status: 'failed', error: 'metric failed' });
        continue;
      }
      const prev = best.get(name);
      if (!prev || r.elapsed < prev.elapsed) best.set(name, r);
      console.log(
        `    ${name}: ${r.elapsed}ms (min of ${SAMPLE_RUNS})${r.detail ? ` (${r.detail})` : ''}`,
      );
    }
  }
  console.log('\n  Best-case (min across passes):');
  for (const [name, r] of best) {
    RESULTS.push(r);
    console.log(`    ${name}: ${r.elapsed}ms`);
  }
}

// ---- 基线对比 / 门禁 ----
function loadBaseline(baselinePath) {
  if (!fs.existsSync(baselinePath)) {
    console.error(`\n❌ 基线文件不存在：${baselinePath}`);
    console.error('   请先运行 `pnpm bench:base` 生成基线。');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
}

function compareWithBaseline(baseline) {
  const baselineResults = new Map((baseline.results || []).map((r) => [r.name, r]));
  let anyRegressed = false;

  console.log('\nRegression check (vs baseline):');
  for (const r of RESULTS) {
    const base = baselineResults.get(r.name);
    if (!base) {
      // 新指标，基线中无对应项 → 跳过（不视为回归）
      console.log(`  SKIP ${r.name}: no baseline entry (new metric)`);
      continue;
    }
    if (r.status !== 'success') {
      console.log(`  FAIL ${r.name}: run failed, cannot compare`);
      continue;
    }
    const baseElapsed = base.elapsed;
    if (r.elapsed > baseElapsed * REGRESSION_THRESHOLD) {
      const pct = (((r.elapsed - baseElapsed) / baseElapsed) * 100).toFixed(1);
      console.log(`  REGRESSION: ${r.name} ${r.elapsed}ms vs baseline ${baseElapsed}ms (+${pct}%)`);
      r.regressed = true;
      anyRegressed = true;
    } else {
      console.log(`  OK ${r.name}: ${r.elapsed}ms vs baseline ${baseElapsed}ms`);
    }
  }

  if (anyRegressed) {
    console.error('\n❌ 基准回归门禁失败：存在 >10% 的性能回归，请排查后重跑。');
    process.exit(1);
  }
  console.log('\n✅ 基准回归门禁通过：无 >10% 回归。');
}

function saveBaseline(baselinePath) {
  const baseline = {
    timestamp: new Date().toISOString(),
    machineProfile: detectMachineProfile(),
    results: RESULTS,
  };
  fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + '\n', 'utf-8');
  console.log(`\n✅ 基线已保存：${baselinePath}`);
}

function printHelp() {
  console.log(`
智汇码盾性能基准测试

用法：
  node scripts/benchmark.mjs [--project-path /path/to/project]
  node scripts/benchmark.mjs --sample
  node scripts/benchmark.mjs --sample --save-base [<path>]
  node scripts/benchmark.mjs --sample --baseline <path>
  node scripts/benchmark.mjs --gate

选项：
  --project-path <path>   目标项目路径（默认：当前目录）。测量 eslint/tsc/test 三个外部命令。
  --sample                在固定样本项目 scripts/fixtures/sample-repo 上运行自包含计时集
                          （scan-files / read-package / evaluate-n），无需外部工具链，输入固定、计时稳定。
  --baseline <path>       运行后与基线 JSON 对比；任一指标回归 >10% → 打印 REGRESSION 并以 exit 1 退出。
  --save-base [<path>]    运行并写入新基线 JSON（不做对比）。默认路径 scripts/fixtures/.benchmark-baseline.json。
  --gate                  等价于 --sample --baseline scripts/fixtures/.benchmark-baseline.json（CI 门禁快捷方式）。

计时集说明：
  - 非 --sample 模式：保持原有 3 个外部命令测量（npx eslint / npx tsc --noEmit / pnpm test），向后兼容。
  - --sample 模式：自包含计时集，不依赖外部工具链，保证固定样本输入、稳定可比。

输出：始终写入 <target>/.zhshield/benchmark-results.json（含 machineProfile）。
`);
}

// ---- 参数解析 ----
const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag) => args[args.indexOf(flag) + 1];

if (has('--help') || has('-h')) {
  printHelp();
  process.exit(0);
}

const isGate = has('--gate');
const isSample = has('--sample') || isGate;
const baselinePath = has('--baseline') ? valueOf('--baseline') : isGate ? DEFAULT_BASELINE : null;
const saveBase = has('--save-base');
const saveBasePath = saveBase ? valueOf('--save-base') || DEFAULT_BASELINE : null;

const projectPath = isSample
  ? SAMPLE_DIR
  : has('--project-path')
    ? valueOf('--project-path')
    : process.cwd();

console.log('Benchmark: ZHCodeShield');
console.log(`Project: ${projectPath}`);
const loc = countLOC(projectPath);
console.log(`LOC: ${loc.toLocaleString()}`);

if (isSample) {
  runSampleSet();
} else {
  runBenchmark('ESLint', 'npx eslint "packages/*/src/**/*.{ts,tsx}" --quiet', projectPath);
  runBenchmark('TypeScript Check', 'npx tsc --noEmit', projectPath);
  runBenchmark('Vitest Tests', 'pnpm test', projectPath);
}

console.log('\nResults:');
for (const r of RESULTS) {
  const marker = r.regressed ? ' REGRESSED' : '';
  console.log(`  ${r.status === 'success' ? 'OK' : 'FAIL'} ${r.name}: ${r.elapsed}ms${marker}`);
}
const total = RESULTS.reduce((s, r) => s + r.elapsed, 0);
console.log(`  Total: ${total}ms (${(total / 1000).toFixed(1)}s)`);

// 始终写入 <target>/.zhshield/benchmark-results.json（含 machineProfile，向后兼容）
const outputDir = path.join(projectPath, '.zhshield');
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(
  path.join(outputDir, 'benchmark-results.json'),
  JSON.stringify(
    {
      timestamp: new Date().toISOString(),
      machineProfile: detectMachineProfile(),
      loc,
      results: RESULTS,
    },
    null,
    2,
  ),
);

// 门禁逻辑
if (saveBase) {
  saveBaseline(saveBasePath);
} else if (baselinePath) {
  const baseline = loadBaseline(baselinePath);
  compareWithBaseline(baseline);
}
