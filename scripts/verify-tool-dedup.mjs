#!/usr/bin/env node
/**
 * A12 验收：同一 (tool, targets, args) 在一次全量运行中只起一次进程
 *
 * 为什么必须"进程级"验：调度器（`pipeline/src/execution/scheduler.ts`）的
 * `execution-scheduler.test.ts` 全绿只能证明**类**在单测里能去重，它的
 * `ToolExecutor.invocationCount()` 统计的是"经过调度器的调用"——主链路若不经过它，
 * 计数恒为 0 而测试照样绿。这正是 A12 至今 ☐ 的原因，也是不能用单测代替的判据。
 *
 * 本脚本从**进程外部**观测：`scripts/lib/tool-spy.cjs` 作为 `--require` 预加载，
 * 替换子进程派发函数并记录 (cmd, args)，因此拿到的是真实派发而不是设计意图。
 *
 * 判据（与《07》§7.1 逐字对齐）：
 *   · 同一 (tool, 完整参数) 出现次数 > 1 → **VIOLATION**（同一把刀同一刀法切了两遍）
 *   · 同一 tool 不同参数出现多次 → 契约允许（不同规则族/目标），但仍是"同一棵树被扫两遍"，
 *     作为 INFO 列出 —— 这是后续合并规则族的候选，不是本次失败项
 *   · 可用性探测（`--version`）单独统计、不参与 VIOLATION 判定：它不是"扫描"，
 *     但同一工具被反复探测本身是浪费（实测 semgrep 3 次 / gitleaks 3 次 / jscpd 2 次），
 *     作为 PROBE 项列出，供"探测结果进程内单飞"这一刀优化
 *   · 一个工具都没观测到 → **INCONCLUSIVE**（预加载没生效或本次域不派发工具），不判 PASS
 *
 * 用法：
 *   node scripts/verify-tool-dedup.mjs                                  # 本仓，全量扫描链
 *   node scripts/verify-tool-dedup.mjs --dir scripts/fixtures/security-mini   # 夹具，快
 *   node scripts/verify-tool-dedup.mjs --domains inspect,security
 *   node scripts/verify-tool-dedup.mjs --keep                            # 保留原始观测日志
 *
 * 退出码：0 PASS / 1 VIOLATION / 2 INCONCLUSIVE / 3 环境错误
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'packages/cli/dist/zhshield.js');
const SPY = path.join(ROOT, 'scripts/lib/tool-spy.cjs');

/** A12 管辖的工具 = capability-registry 登记的 bin（不含 npm/pnpm/git 这类宿主命令） */
const WATCHED = [
  'semgrep',
  'gitleaks',
  'trivy',
  'tsc',
  'eslint',
  'jscpd',
  'ts-prune',
  'depcheck',
  'depcruise',
];

function parseArgs(argv) {
  const args = { domains: '', dir: ROOT, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--domains') args.domains = argv[++i] ?? '';
    else if (a === '--dir') args.dir = path.resolve(argv[++i]);
    else if (a === '--keep') args.keep = true;
    else if (a === '--help' || a === '-h') {
      console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
      process.exit(0);
    } else {
      console.error(`未知参数: ${a}`);
      process.exit(3);
    }
  }
  return args;
}

/**
 * 派发命令 → 工具名。
 *
 * 两种形态都要认：直接执行工具 bin（`.../node_modules/.bin/semgrep`），
 * 以及经 node 跑工具入口（`node .../typescript/bin/tsc`）——后者名称不在 basename 上。
 */
function toolOf(record) {
  const base = path.basename(record.cmd);
  const direct = base.replace(/\.(c|m)?js$/i, '');
  if (WATCHED.includes(direct)) return direct;
  if (base === 'node' || base === 'nodejs') {
    const joined = record.args.join(' ');
    for (const tool of WATCHED) {
      if (new RegExp(`(^|/)${tool}([./]|$)`).test(joined)) return tool;
    }
    if (/typescript\/(bin|lib)\/tsc/.test(joined)) return 'tsc';
    if (/dependency-cruiser|depcruise/.test(joined)) return 'depcruise';
  }
  return null;
}

async function runOnce(args, logPath, ledgerPath) {
  const cliArgs = [
    '--require',
    SPY,
    DIST,
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

  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, cliArgs, {
      cwd: args.dir,
      env: { ...process.env, ZH_TOOL_SPY_LOG: logPath, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stdout.on('data', () => {});
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('close', (code) =>
      resolve({ exitCode: code, elapsedMs: Date.now() - startedAt, stderr }),
    );
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(DIST)) {
    console.error(`❌ 构建产物不存在：${DIST}\n   先跑 pnpm --filter zhshield-cli build`);
    process.exit(3);
  }

  const stamp = `${process.pid}-${Date.now()}`;
  const logPath = path.join(os.tmpdir(), `zhshield-tool-spy-${stamp}.jsonl`);
  const ledgerPath = path.join(os.tmpdir(), `zhshield-tool-dedup-${stamp}.json`);
  fs.rmSync(logPath, { force: true });

  console.log('A12 工具进程去重验收');
  console.log(`  链路：构建产物 pipeline --full --domains ${args.domains || '(全量扫描链)'}`);
  console.log(`  观测：child_process 派发（--require tool-spy.cjs），非 ps 采样`);

  const run = await runOnce(args, logPath, ledgerPath);
  const lines = fs.existsSync(logPath)
    ? fs
        .readFileSync(logPath, 'utf8')
        .split('\n')
        .filter((l) => l.trim().length > 0)
    : [];

  const records = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      const tool = toolOf(parsed);
      if (tool) records.push({ tool, kind: parsed.kind, cmd: parsed.cmd, args: parsed.args });
    } catch {
      // 单行损坏不影响其余观测
    }
  }

  let ledger = null;
  try {
    ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  } catch {
    // 账本缺失不影响工具派发计数（那是进程外观测），只是少一层域状态展示
  }

  console.log(`  运行：${(run.elapsedMs / 1000).toFixed(2)}s，exit=${run.exitCode}`);
  for (const record of ledger?.records ?? []) {
    console.log(`    ${record.domain} ${record.status} ${(record.durationMs / 1000).toFixed(2)}s`);
  }

  /** 可用性探测不是"扫描"，但同一工具被反复探测是浪费 —— 单列统计 */
  const isProbe = (record) => record.args.length === 1 && record.args[0] === '--version';
  const probes = records.filter((record) => isProbe(record));
  const scans = records.filter((record) => !isProbe(record));

  const probeByTool = new Map();
  for (const record of probes)
    probeByTool.set(record.tool, (probeByTool.get(record.tool) ?? 0) + 1);

  /** A12 的键：同一工具 + 完整参数 */
  const byKey = new Map();
  const byTool = new Map();
  for (const record of scans) {
    const key = `${record.tool}\u0000${record.args.join(' ')}`;
    byKey.set(key, (byKey.get(key) ?? 0) + 1);
    const entry = byTool.get(record.tool) ?? { count: 0, argv: new Set() };
    entry.count += 1;
    entry.argv.add(record.args.join(' '));
    byTool.set(record.tool, entry);
  }

  console.log('\n  观测到的工具扫描派发（不含 --version 探测）:');
  if (byTool.size === 0) {
    console.log('    （无）');
  }
  for (const [tool, entry] of [...byTool.entries()].sort()) {
    const note = entry.count > 1 ? ` ← ${entry.count} 次 / ${entry.argv.size} 组参数` : '';
    console.log(`    ${tool}: ${entry.count}${note}`);
  }
  if (probeByTool.size > 0) {
    const probeLine = [...probeByTool.entries()]
      .map(([tool, count]) => `${tool}×${count}`)
      .join('  ');
    console.log(`  可用性探测（--version，不计入 A12 判据）: ${probeLine}`);
  }

  const violations = [...byKey.entries()].filter(([, count]) => count > 1);
  const sameToolTwice = [...byTool.entries()].filter(([, entry]) => entry.count > 1);
  const repeatedProbes = [...probeByTool.entries()].filter(([, count]) => count > 1);

  /**
   * 合并规则族的回归哨兵：每条 SOP semgrep 规则都带一份 `--config <tmp>/zhshield-semgrep-XXXX/inline-rules.yml`，
   * 合并成一次进程后这类派发应当 ≤1。它不会触发 VIOLATION（参数不同，契约允许），
   * 但"从 1 变成 N"正是批量派发被绕过的特征，必须显式出现在输出与账本里。
   */
  const inlineRuleScans = scans.filter(
    (record) => record.tool === 'semgrep' && record.args.some((a) => String(a).includes('zhshield-semgrep-')),
  );
  if (inlineRuleScans.length > 1) {
    console.log(
      `\n  WARN semgrep 内联规则族疑似未合并：${inlineRuleScans.length} 次独立内联规则扫描（应 ≤1）`,
    );
  }

  if (sameToolTwice.length > 0) {
    console.log('\n  INFO 同一工具多次扫描（参数不同 —— 契约允许，但是合并规则族的候选）:');
    for (const [tool, entry] of sameToolTwice) {
      console.log(`    ${tool} × ${entry.count}（${entry.argv.size} 组参数）`);
      for (const argv of [...entry.argv].slice(0, 3)) {
        console.log(`      ${argv.slice(0, 160)}${argv.length > 160 ? ' …' : ''}`);
      }
    }
  }

  if (repeatedProbes.length > 0) {
    console.log('\n  WARN 同一工具被反复探测（--version）— 探测结果应进程内单飞:');
    for (const [tool, count] of repeatedProbes) console.log(`    ${tool} × ${count}`);
  }

  if (violations.length > 0) {
    console.log('\n  VIOLATION 同一 (tool, args) 起了多次扫描进程:');
    for (const [key, count] of violations) {
      const [tool, argv] = key.split('\u0000');
      console.log(`    ${tool} × ${count}: ${argv.slice(0, 200)}`);
    }
  }

  const artifact = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    target: 'A12',
    criterion: '同一 (tool, args) 的扫描派发次数 = 1（--version 探测不计入，单独统计）',
    verdict:
      violations.length > 0
        ? 'VIOLATION'
        : byTool.size === 0 && probeByTool.size === 0
          ? 'INCONCLUSIVE'
          : 'PASS',
    // 批量派发的回归哨兵：semgrep 的内联规则族应当合并成 ≤1 次进程
    // （每条规则一份 `--config <tmp>/zhshield-semgrep-*/inline-rules.yml` 是合并失效的特征）。
    // 不计入 VIOLATION —— 契约允许"参数不同就多次"，但趋势变了要看得见。
    batching: {
      inlineRuleScans: inlineRuleScans.length,
      note:
        inlineRuleScans.length > 1
          ? `合并规则族未生效（应 ≤1，实测 ${inlineRuleScans.length}）——检查 prefetch-tool-batch / scanBatch 是否被绕过`
          : '内联规则族已合并（≤1 次进程）',
    },
    command: `node scripts/verify-tool-dedup.mjs --domains ${args.domains || '(全量扫描链)'}`,
    domains: args.domains || '(全量扫描链)',
    scannedDir: path.relative(ROOT, args.dir) || '.',
    exitCode: run.exitCode,
    elapsedMs: run.elapsedMs,
    domainStatuses: Object.fromEntries((ledger?.records ?? []).map((r) => [r.domain, r.status])),
    dispatches: Object.fromEntries(
      [...byTool.entries()].map(([tool, entry]) => [
        tool,
        { count: entry.count, distinctArgv: entry.argv.size, argv: [...entry.argv] },
      ]),
    ),
    versionProbes: Object.fromEntries(probeByTool),
    violations: Object.fromEntries(
      violations.map(([key, count]) => [key.replace('\u0000', ' | '), count]),
    ),
  };

  const outPath = path.join(ROOT, '.zhshield', 'bench', `tool-dedup-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  console.log(`\n  账本: ${path.relative(ROOT, outPath)}`);

  if (args.keep) console.log(`  原始观测: ${logPath}`);
  else fs.rmSync(logPath, { force: true });
  fs.rmSync(ledgerPath, { force: true });

  if (artifact.verdict === 'VIOLATION') {
    console.log('❌ VIOLATION — 同一 (tool, args) 起了多次扫描进程，A12 不成立');
    process.exit(1);
  }
  if (artifact.verdict === 'INCONCLUSIVE') {
    console.log('⚠️  INCONCLUSIVE — 未观测到任何工具派发，可能预加载未生效或本次域不调用工具');
    process.exit(2);
  }
  console.log('✅ PASS — 每个 (tool, args) 只扫描了一次');
  process.exit(0);
}

main().catch((err) => {
  console.error('验收脚本异常:', err);
  process.exit(3);
});
