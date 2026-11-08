#!/usr/bin/env node
/**
 * 空闲窗口自动补跑验收（A12 / A14 / A15）——把"等人有空、等机器不忙"变成一条命令。
 *
 * 为什么需要它：《07》§7.7 立了"一条命令 + 一个退出码 + 一份账本"的规矩，但 A12/A14
 * 的判据都带**机器负载前提**（`bench:pipeline` 起跑前 1min load > 核数即 INVALID）。
 * 现实中"机器空"是个随机窗口：人守着跑一次要 10 分钟，等不到就干脆不测，于是结论
 * 在"达标/未达标"之间来回翻转（A14 已经来回两次，2026-11-05 四份账本全是 INVALID/半程）。
 * 本脚本把等待也机器化：轮询 loadavg，一旦低于门限就依次跑验收，账本记下每一步的
 * 退出码与判定，人只看最后一行。
 *
 * 判据沿用各脚本自己的退出码，本脚本只做编排与归并：
 *   verify:tool-dedup    0 PASS / 1 VIOLATION / 2 INCOMPLETE 或 INCONCLUSIVE
 *   bench:pipeline       0 PASS / 1 FAIL     / 2 INVALID（负载/产物/域不全）
 *   verify:offline       0 PASS / 1 场景不符
 *
 * 归并口径（与 §7.7「INVALID 与 FAIL 分开」一致）：
 *   · 任一步 FAIL / VIOLATION → `FAILED`，exit 1
 *   · 无 FAIL 但有 INVALID / INCOMPLETE → `NO_CREDENTIAL`，exit 2（没有凭据 ≠ 未达标）
 *   · 全 PASS → `PASS`，exit 0
 *   · 等不到空闲窗口 → `TIMEOUT`，exit 3（不动用任何旧账本，也不伪造通过）
 *
 * 用法：
 *   pnpm verify:idle                       # 最多等 180 分钟，空闲即跑全部三项
 *   pnpm verify:idle -- --check            # 只报告当前负载与将要跑的步骤，不执行
 *   pnpm verify:idle -- --steps dedup      # 只跑指定步骤（dedup,bench,offline）
 *   pnpm verify:idle -- --max-wait-min 30 --interval-sec 30
 *   pnpm verify:idle -- --allow-load       # 放行（带载测量，账本会记 INVALID 语义）
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 步骤定义：命令、退出码语义、账本前缀 */
const STEPS = {
  dedup: {
    label: 'A12 工具去重（verify:tool-dedup）',
    script: 'scripts/verify-tool-dedup.mjs',
    ok: [0],
    fail: [1],
    noCredential: [2],
  },
  bench: {
    label: 'A14 全量时长（bench:pipeline，3 次中位数）',
    script: 'scripts/bench-pipeline.mjs',
    ok: [0],
    fail: [1],
    noCredential: [2],
  },
  offline: {
    label: 'A15 断网端到端（verify:offline）',
    script: 'scripts/verify-offline-deps.mjs',
    ok: [0],
    fail: [1],
    noCredential: [2],
  },
};

function parseArgs(argv) {
  const args = {
    steps: ['dedup', 'bench', 'offline'],
    maxWaitMin: 180,
    intervalSec: 60,
    cooldownSec: 45,
    loadFactor: 1,
    check: false,
    allowLoad: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--check') args.check = true;
    else if (a === '--allow-load') args.allowLoad = true;
    else if (a === '--steps') {
      const raw = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      const unknown = raw.filter((s) => !(s in STEPS));
      if (raw.length === 0 || unknown.length > 0) {
        console.error(`--steps 需要 ${Object.keys(STEPS).join('/')} 的组合，收到: ${raw.join(',')}`);
        process.exit(3);
      }
      args.steps = raw;
    } else if (a === '--max-wait-min') args.maxWaitMin = Number(argv[++i] ?? 0);
    else if (a === '--interval-sec') args.intervalSec = Number(argv[++i] ?? 0);
    else if (a === '--cooldown-sec') args.cooldownSec = Number(argv[++i] ?? 0);
    else if (a === '--load-factor') args.loadFactor = Number(argv[++i] ?? 1);
    else if (a === '--help' || a === '-h') {
      console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
      process.exit(0);
    } else {
      console.error(`未知参数: ${a}`);
      process.exit(3);
    }
  }
  if (!Number.isFinite(args.maxWaitMin) || args.maxWaitMin < 0) args.maxWaitMin = 180;
  if (!Number.isFinite(args.intervalSec) || args.intervalSec < 5) args.intervalSec = 60;
  if (!Number.isFinite(args.cooldownSec) || args.cooldownSec < 0) args.cooldownSec = 45;
  if (!Number.isFinite(args.loadFactor) || args.loadFactor <= 0) args.loadFactor = 1;
  return args;
}

/** 与 `bench-pipeline.mjs` 同一口径：门限 = 核数 × 系数（默认 1，即"一核一件活"） */
function loadGate(cores, factor) {
  return Math.max(1, Math.round(cores * factor));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 等到 1min load ≤ 门限。
 *
 * 必须**每一步之前都等一次**：验收本身是重 CPU 负载（一次 `--full` 拉满 4 核数分钟），
 * 起跑前空、跑完立刻接下一步，后一步自己的负载门限必然读到"不空" —— 2026-11-05 首次
 * 自动补跑就是这样：dedup 跑完 382s，紧接着 bench 在 364ms 内判 INVALID 退出。
 */
async function waitForIdle({ gate, deadline, intervalSec, onWait }) {
  let waitedMs = 0;
  let load = os.loadavg()[0];
  while (load > gate) {
    if (Date.now() >= deadline) return { idle: false, load, waitedMs };
    onWait(load, waitedMs);
    await sleep(intervalSec * 1000);
    waitedMs += intervalSec * 1000;
    load = os.loadavg()[0];
  }
  return { idle: true, load, waitedMs };
}

function runStep(key) {
  const step = STEPS[key];
  const startedAt = Date.now();
  const result = spawnSync(process.execPath, [path.join(ROOT, step.script)], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, NO_COLOR: '1' },
  });
  const exitCode = result.status ?? 3;
  const verdict = step.ok.includes(exitCode)
    ? 'PASS'
    : step.fail?.includes(exitCode)
      ? 'FAIL'
      : step.noCredential?.includes(exitCode)
        ? 'NO_CREDENTIAL'
        : 'ERROR';
  return { step: key, label: step.label, exitCode, verdict, elapsedMs: Date.now() - startedAt };
}

/** 归并：FAIL 优先；其次"没有凭据"；全 PASS 才算通过 */
function aggregate(results) {
  if (results.some((r) => r.verdict === 'FAIL' || r.verdict === 'ERROR')) return 'FAILED';
  if (results.some((r) => r.verdict === 'NO_CREDENTIAL')) return 'NO_CREDENTIAL';
  return 'PASS';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cores = os.cpus().length;
  const gate = loadGate(cores, args.loadFactor);
  const deadline = Date.now() + args.maxWaitMin * 60_000;

  console.log('空闲窗口自动验收（A12 / A14 / A15）');
  console.log(`  机器：${cores} 核 · ${Math.round(os.totalmem() / 1024 ** 3)}GB`);
  console.log(`  步骤：${args.steps.join(' → ')}`);
  console.log(`  负载门限：1min load ≤ ${gate}（核数 × ${args.loadFactor}）`);

  const results = [];
  const skipped = [];
  let waitedMs = 0;
  const loadAtStart = os.loadavg()[0];

  if (args.check) {
    if (loadAtStart > gate) {
      console.log(`\n当前 load ${loadAtStart.toFixed(2)} > 门限 ${gate} —— 现在跑只会得到 INVALID/INCOMPLETE`);
      console.log('（--check 只看不跑；去掉 --check 即进入等待）');
      process.exit(2);
    }
    console.log(`\n当前 load ${loadAtStart.toFixed(2)} ≤ 门限 ${gate} —— 现在跑可以拿到凭据`);
    process.exit(0);
  }

  for (const key of args.steps) {
    const wait = args.allowLoad
      ? { idle: true, load: os.loadavg()[0], waitedMs: 0 }
      : await waitForIdle({
          gate,
          deadline,
          intervalSec: args.intervalSec,
          onWait: (load, waited) =>
            console.log(
              `  等待 ${key}：load ${load.toFixed(2)} > ${gate}（本次已等 ${Math.round(waited / 60_000)} 分钟）`,
            ),
        });
    waitedMs += wait.waitedMs;

    if (!wait.idle) {
      skipped.push(key);
      break; // 剩余步骤同样等不到窗口，不再空转
    }

    console.log(`\n=== ${STEPS[key].label} ===`);
    console.log(`  起跑：load ${wait.load.toFixed(2)} ≤ ${gate}${args.allowLoad ? '（--allow-load 放行）' : ''}`);
    const result = runStep(key);
    result.loadAtStart = wait.load;
    results.push(result);
    const mark = result.verdict === 'PASS' ? '✅' : result.verdict === 'FAIL' ? '❌' : '⚠️ ';
    console.log(`${mark} ${key}: exit=${result.exitCode} → ${result.verdict}（${(result.elapsedMs / 1000).toFixed(1)}s）`);

    // 冷却：上一步的负载余波会污染下一步起跑前的 1min loadavg
    if (key !== args.steps[args.steps.length - 1]) {
      await sleep(args.cooldownSec * 1000);
      waitedMs += args.cooldownSec * 1000;
    }
  }

  const loadAfter = os.loadavg()[0];
  const verdict =
    results.length === 0 || skipped.length > 0 ? 'TIMEOUT' : aggregate(results);
  const ledger = buildLedger({
    args,
    cores,
    gate,
    loadBefore: loadAtStart,
    loadAfter,
    waitedMs,
    results,
    verdict,
    skipped,
  });
  const outPath = writeLedger(ledger);

  console.log(`\n汇总：${verdict}`);
  for (const r of results) console.log(`  ${r.step.padEnd(8)} ${r.verdict.padEnd(14)} exit=${r.exitCode}`);
  if (skipped.length > 0) console.log(`  未执行（等不到空闲窗口）：${skipped.join(', ')}`);
  console.log(`  账本: ${path.relative(ROOT, outPath)}`);

  if (verdict === 'PASS') {
    console.log('\n✅ PASS — 全部步骤都拿到了凭据');
    process.exit(0);
  }
  if (verdict === 'TIMEOUT') {
    console.log('\n⚠️  TIMEOUT — 有步骤没等到空闲窗口，序列不完整，不作凭据（已完成步骤的结果仍在账本里）');
    process.exit(3);
  }
  if (verdict === 'NO_CREDENTIAL') {
    console.log('\n⚠️  NO_CREDENTIAL — 有步骤没拿到有效凭据（INVALID/INCOMPLETE），既不算通过也不算未达标');
    process.exit(2);
  }
  console.log('\n❌ FAILED — 有步骤明确不达标或出现违规，详见各自账本');
  process.exit(1);
}

function buildLedger({
  args,
  cores,
  gate,
  loadBefore,
  loadAfter,
  waitedMs,
  results,
  verdict,
  skipped = [],
}) {
  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    target: 'A12+A14+A15 空闲窗口补跑',
    criterion:
      '全部步骤拿到 PASS 凭据才算通过；INVALID/INCOMPLETE 记 NO_CREDENTIAL，等不到窗口记 TIMEOUT——两者都不判通过也不判未达标',
    verdict,
    machine: {
      cores,
      totalMemGb: Math.round(os.totalmem() / 1024 ** 3),
      platform: `${os.platform()}/${os.arch()}`,
      node: process.version,
    },
    loadGate: gate,
    loadFactor: args.loadFactor,
    loadBefore,
    loadAfter,
    waitedMs,
    cooldownSec: args.cooldownSec,
    allowLoad: args.allowLoad,
    steps: results,
    skippedSteps: skipped,
    note:
      verdict === 'NO_CREDENTIAL'
        ? '机器仍未真正空闲或域被预算掐断 —— 换窗口重跑，不要把本次结论当凭据'
        : verdict === 'TIMEOUT'
          ? '序列不完整：已完成步骤的结果仍有效，但整体不构成凭据'
          : undefined,
  };
}

function writeLedger(ledger) {
  const dir = path.join(ROOT, '.zhshield', 'bench');
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, `idle-verify-${Date.now()}.json`);
  fs.writeFileSync(outPath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  return outPath;
}

main().catch((err) => {
  console.error('空闲验收编排异常:', err);
  process.exit(3);
});
