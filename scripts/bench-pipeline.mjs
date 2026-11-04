#!/usr/bin/env node
/**
 * A14 验收：全量流水线时长（本机、并发 1、构建产物）
 *
 * 为什么需要这个脚本（而不是"再跑一次看看"）：
 *   A14 的结论曾两次反转 —— 89.8s（42 条规则、无头驱动）→ 198.9s（85 条规则、CLI --full）
 *   → 又因"单次样本 + 同机有负载"被降级为待复测。争的不是数字，是**口径**：
 *     1) 规则集不同（42 vs 85 条）不可比；
 *     2) 单次样本不可判；
 *     3) 有负载的机器上跑出来的数不可判。
 *   本脚本把这三条写成机器可判的条件：固定入口（构建产物 CLI）、N 次取中位数、
 *   负载门限不满足就拒绝出结论（INVALID 而不是 PASS/FAIL），并把出处（commit /
 *   dist 哈希 / 规则数 / 负载）一起写进账本。没有账本的数字一律不作凭据。
 *
 * 判据（三条全满足才 PASS）：
 *   · 负载门限：**起跑前** 1min load ≤ 核数（`--max-load` 可改；`--allow-load` 允许带载运行，
 *     但结论一律记 INVALID —— 带载跑出的数没有效力，不是"未达标"也不是"达标"）。
 *     「止」load 只作告警记入账本，不参与判定 —— 流水线本身 CPU 密集，跑完 load 必然
 *     超核数，用它判定会让本门禁**永远 INVALID**（2026-11-04 实测白跑 3 次 11 分钟）
 *   · 产物新鲜：dist 比 `packages/*\/src` 最新改动更新（`--allow-stale` 可跳过）
 *   · 时长与完整性：wallMs 中位数 ≤ 目标（默认 180s），且 N 次里没有域落 `unavailable`/`partial`
 *     —— 域被预算掐断的那次跑的不是"完整流水线"，拿它的时长当 A14 凭据是假通过（C4）
 *
 * 用法：
 *   node scripts/bench-pipeline.mjs                    # 3 次，本仓，构建产物
 *   node scripts/bench-pipeline.mjs --runs 5
 *   node scripts/bench-pipeline.mjs --domains security,refactor   # 只管某几域（出具部分账本）
 *   node scripts/bench-pipeline.mjs --allow-load --runs 1         # 出参考值，结论必为 INVALID
 *
 * 退出码：0 PASS / 1 FAIL / 2 INVALID（负载或产物不达标，不可作为凭据）/ 3 环境错误
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'packages/cli/dist/zhshield.js');
const TARGET_MS = 180_000;

function parseArgs(argv) {
  const args = {
    runs: 3,
    dir: ROOT,
    domains: '',
    targetMs: TARGET_MS,
    out: '',
    maxLoad: null,
    allowLoad: false,
    allowStale: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--runs') args.runs = Number(argv[++i]);
    else if (a === '--dir') args.dir = path.resolve(argv[++i]);
    else if (a === '--domains') args.domains = argv[++i] ?? '';
    else if (a === '--target-ms') args.targetMs = Number(argv[++i]);
    else if (a === '--max-load') args.maxLoad = Number(argv[++i]);
    else if (a === '--out') args.out = path.resolve(argv[++i]);
    else if (a === '--allow-load') args.allowLoad = true;
    else if (a === '--allow-stale') args.allowStale = true;
    else if (a === '--help' || a === '-h') {
      console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
      process.exit(0);
    } else {
      console.error(`未知参数: ${a}`);
      process.exit(3);
    }
  }
  if (!Number.isFinite(args.runs) || args.runs < 1) {
    console.error('--runs 必须是 ≥1 的整数');
    process.exit(3);
  }
  return args;
}

/** 1min load 门限：CPU 密集测量的有效性前提是"每个可运行线程都拿得到核" */
function loadGate(cores) {
  return Math.max(1, cores);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function distFingerprint() {
  if (!fs.existsSync(DIST)) return null;
  const buf = fs.readFileSync(DIST);
  return {
    path: path.relative(ROOT, DIST),
    mtime: fs.statSync(DIST).mtime.toISOString(),
    bytes: buf.length,
    sha256_12: createHash('sha256').update(buf).digest('hex').slice(0, 12),
  };
}

/**
 * 产物新鲜度：dist 必须比 `packages/*\/src` 里最新的源文件更新。
 * 拿旧产物量新代码是性能验收最常见的一类假数据，故默认视为 INVALID。
 */
function newestSourceMtime() {
  let newest = 0;
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        walk(full);
      } else if (/\.(ts|tsx|mts|cts)$/.test(entry.name)) {
        const m = fs.statSync(full).mtimeMs;
        if (m > newest) newest = m;
      }
    }
  };
  walk(path.join(ROOT, 'packages'));
  return newest;
}

function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
}

/** 单次运行：spawn 构建产物，时间由外部量（含进程启动，正是一线用户感知到的墙钟） */
function runOnce(args, ledgerPath) {
  return new Promise((resolve) => {
    const cliArgs = [
      'pipeline',
      '--full',
      '--dir',
      args.dir,
      '--format',
      'json',
      '--report',
      ledgerPath,
    ];
    if (args.domains) cliArgs.push('--domains', args.domains);
    const startedAt = process.hrtime.bigint();
    const child = spawn(process.execPath, [DIST, ...cliArgs], {
      cwd: args.dir,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stdout.on('data', () => {});
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('close', (code) => {
      const wallMs = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
      let ledger = null;
      try {
        ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
      } catch {
        // 落盘失败按"无账本"处理：由 incompleteDomains 记 <无账本>，不静默当跑完
      }
      resolve({
        wallMs,
        exitCode: code,
        ledger,
        stderrTail: stderr.trim().split('\n').slice(-3).join('\n'),
      });
    });
  });
}

/** 域状态是否"完整跑完"：unavailable/partial 的时长不能当 A14 凭据 */
function incompleteDomains(ledger) {
  if (!ledger?.records) return ['<无账本>'];
  return ledger.records
    .filter((r) => r.status === 'unavailable' || r.status === 'partial')
    .map((r) => `${r.domain}(${r.status})`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cores = os.cpus().length;
  const gate = args.maxLoad ?? loadGate(cores);
  const loadBefore = os.loadavg()[0];

  const dist = distFingerprint();
  if (!dist) {
    console.error(`❌ 构建产物不存在：${DIST}\n   先跑 pnpm --filter zhshield-cli build`);
    process.exit(3);
  }
  const srcMtime = newestSourceMtime();
  const distStale = srcMtime > new Date(dist.mtime).getTime();

  console.log('A14 全量流水线时长验收');
  console.log(
    `  目标：wallMs 中位数 ≤ ${args.targetMs}ms（${args.targetMs / 1000}s），N=${args.runs}`,
  );
  console.log(
    `  产物：${dist.path} ${dist.sha256_12} (${dist.mtime})${distStale ? ' ⚠ 比源码旧' : ''}`,
  );
  console.log(
    `  机器：${cores} 核 / ${(os.totalmem() / 1024 ** 3).toFixed(1)}GB / node ${process.version}`,
  );
  console.log(`  负载：1min=${loadBefore.toFixed(2)}（门限 ${gate}）`);

  if (loadBefore > gate && !args.allowLoad) {
    console.error(
      `\n⚠️  INVALID — 起跑前 1min load ${loadBefore.toFixed(2)} 已超门限 ${gate}。\n` +
        `   此时段测出的时长不反映代码质量（A14 曾因此结论翻转一次）。\n` +
        `   等机器空下来再跑，或加 --allow-load 只取参考值（结论仍记 INVALID）。`,
    );
    process.exit(2);
  }

  const runs = [];
  for (let i = 1; i <= args.runs; i++) {
    const ledgerPath = path.join(os.tmpdir(), `zhshield-bench-${process.pid}-${i}.json`);
    try {
      fs.rmSync(ledgerPath, { force: true });
    } catch {}
    const loadAtStart = os.loadavg()[0];
    const result = await runOnce(args, ledgerPath);
    const incomplete = incompleteDomains(result.ledger);
    runs.push({
      index: i,
      wallMs: result.wallMs,
      sumMs: result.ledger?.sumMs ?? null,
      exitCode: result.exitCode,
      loadAtStart: Number(loadAtStart.toFixed(2)),
      incomplete,
      perDomain: Object.fromEntries(
        (result.ledger?.records ?? []).map((r) => [r.domain, `${r.status}:${r.durationMs}`]),
      ),
    });
    console.log(
      `  run ${i}/${args.runs}: ${(result.wallMs / 1000).toFixed(2)}s  load=${loadAtStart.toFixed(2)}` +
        `  exit=${result.exitCode}` +
        (incomplete.length > 0 ? `  ⚠ 未完成域: ${incomplete.join(', ')}` : ''),
    );
    try {
      fs.rmSync(ledgerPath, { force: true });
    } catch {}
  }

  const loadAfter = os.loadavg()[0];
  const walls = runs.map((r) => r.wallMs);
  const medianWallMs = Math.round(median(walls));
  const domainNames = [...new Set(runs.flatMap((r) => Object.keys(r.perDomain)))];
  const perDomainMedian = Object.fromEntries(
    domainNames.map((name) => {
      const durations = runs
        .map((r) => r.perDomain[name])
        .filter(Boolean)
        .map((v) => Number(String(v).split(':')[1]));
      return [
        name,
        {
          medianMs: durations.length > 0 ? Math.round(median(durations)) : null,
          statuses: [...new Set(runs.map((r) => String(r.perDomain[name] ?? '-').split(':')[0]))],
        },
      ];
    }),
  );

  const anyIncomplete = runs.some((r) => r.incomplete.length > 0);
  // 负载门限只看**起跑前**的 1min load —— 与本脚本头部和《07》文档的判据一致。
  //
  // 为什么不能用「止」load：流水线本身就是 CPU 密集的（实测 security 域一趟能把
  // 4 核机器的 load 拉到 7+），跑完 load 必然超过核数 ⇒ 该条件自我实现，
  // **每次都判 INVALID**，A14 永远出不了结论。2026-11-04 实测：起跑前 load=2.41
  // （达标），跑完 load=7.63 → 判 INVALID，白跑 3 次 11 分钟。
  //
  // 「止」load 仍有价值：它说明**测量期间有外部干扰**（若有其它进程抢核，本机读数
  // 会被拉高）。故保留为**告警**：超门限则结论降级为参考值，但不再作为 INVALID
  // 的唯一理由 —— 起跑前达标 + N 次无残缺域，结论仍按数据判 PASS/FAIL。
  const loadBeforeOver = loadBefore > gate;
  const loadAfterOver = loadAfter > gate;
  let verdict;
  const reasons = [];
  if (loadBeforeOver) {
    // 起跑前就带载：测出的时长不反映代码质量，只能出参考值 —— 永不判 PASS/FAIL
    verdict = 'INVALID';
    reasons.push(
      `起跑前 1min load ${loadBefore.toFixed(2)} 超门限 ${gate} —— 本次数据不作 A14 凭据，仅供参考`,
    );
    if (anyIncomplete) reasons.push('且存在域被预算掐断（unavailable/partial）');
  } else if (distStale && !args.allowStale) {
    verdict = 'INVALID';
    reasons.push('构建产物比源码旧，量到的不是当前代码');
  } else if (anyIncomplete) {
    verdict = 'FAIL';
    reasons.push(
      '存在域被预算掐断（unavailable/partial），本次不是完整流水线，时长不可作 A14 凭据',
    );
  } else if (medianWallMs > args.targetMs) {
    verdict = 'FAIL';
    reasons.push(`wallMs 中位数 ${medianWallMs}ms > 目标 ${args.targetMs}ms`);
  } else {
    verdict = 'PASS';
    reasons.push(`wallMs 中位数 ${medianWallMs}ms ≤ 目标 ${args.targetMs}ms，且 N 次均无未完成域`);
  }
  // 测量期间有外部干扰的告警（不改变上面的判定，但必须留在账本里）：
  // 起跑前达标说明「测量是在干净状态下开始的」，但跑完 load 偏高意味着期间
  // 可能有其它进程抢核 —— 结论仍可用，只是可信度打折，故显式记录而非静默。
  if (!loadBeforeOver && loadAfterOver) {
    reasons.push(
      `⚠️ 测量期间负载升高（止 ${loadAfter.toFixed(2)} > 门限 ${gate}），可能存在外部进程抢核`,
    );
  }

  const artifact = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    target: 'A14',
    criterion: 'wallMs 中位数 ≤ 目标，且无域 unavailable/partial，且负载/产物门限达标',
    targetMs: args.targetMs,
    verdict,
    reasons,
    command: `node scripts/bench-pipeline.mjs --runs ${args.runs}${args.domains ? ` --domains ${args.domains}` : ''}`,
    provenance: {
      gitCommit: gitCommit(),
      dist,
      distStale,
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      cores,
      totalMemGb: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
      loadBefore: Number(loadBefore.toFixed(2)),
      loadAfter: Number(loadAfter.toFixed(2)),
      loadGate: gate,
      scannedDir: args.dir,
      domains: args.domains || '(全量扫描链)',
    },
    runs,
    medianWallMs,
    medianSumMs: runs.every((r) => r.sumMs !== null)
      ? Math.round(median(runs.map((r) => r.sumMs)))
      : null,
    perDomainMedian,
  };

  const outPath = args.out || path.join(ROOT, '.zhshield', 'bench', `pipeline-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');

  console.log(`\n  wallMs 中位数: ${medianWallMs}ms（各次 ${walls.join(' / ')}）`);
  for (const [name, info] of Object.entries(perDomainMedian)) {
    console.log(`    ${name}: ${info.medianMs}ms ${info.statuses.join('/')}`);
  }
  console.log(`\n  账本: ${path.relative(ROOT, outPath)}`);

  const exitCode = { PASS: 0, FAIL: 1, INVALID: 2 }[verdict] ?? 3;
  const banner = { PASS: '✅ PASS', FAIL: '❌ FAIL', INVALID: '⚠️  INVALID' }[verdict];
  console.log(`${banner} — ${reasons.join('；')}`);
  process.exit(exitCode);
}

main().catch((err) => {
  console.error('验收脚本异常:', err);
  process.exit(3);
});
