// 独立类型检查脚本：遍历 packages/* 下所有含 tsconfig.json 的包，
// 运行 tsc --noEmit --composite false（避免 composite 项目的 emit 限制）。
//
// 用法：
//   node scripts/typecheck.mjs                  # 自动检测内存，8GB 机器单线程
//   node scripts/typecheck.mjs --concurrency 2  # 强制并发数
//   node scripts/typecheck.mjs --batch-size 3    # 每批运行3个包
//   pnpm typecheck
//
// 8GB 机器自动降级为单线程，避免 SIGKILL（OOM）。
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import * as os from 'node:os';

// ── 参数解析 ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flags = {};
for (let i = 2; i < args.length; i += 2) {
  const key = args[i]?.replace(/^--/, '');
  const val = args[i + 1];
  if (key && val) flags[key] = val;
}

const root = process.cwd();
const pkgsDir = join(root, 'packages');

if (!existsSync(pkgsDir)) {
  console.error('未找到 packages/ 目录，请在仓库根目录运行');
  process.exit(1);
}

// ── 内存感知并发 ──────────────────────────────────────────────────────────────
const TOTAL_MEM = os.totalmem();
const LOW_MEM_THRESHOLD = 8 * 1024 ** 3; // 8 GB

function resolveConcurrency() {
  // 显式 --concurrency 优先
  const explicit = Number.parseInt(flags.concurrency ?? flags.c ?? '', 10);
  if (Number.isFinite(explicit) && explicit >= 1) {
    return Math.min(explicit, 4);
  }

  // 低内存机器：单线程
  if (TOTAL_MEM <= LOW_MEM_THRESHOLD) {
    return 1;
  }

  // 正常机器：cpu 数量封顶 4
  return Math.min(os.cpus().length, 4);
}

const CONCURRENCY = resolveConcurrency();
const BATCH_SIZE = CONCURRENCY; // batch-size 为别名，后续可扩展

// ── 发现包 ────────────────────────────────────────────────────────────────────
const pkgs = readdirSync(pkgsDir).filter(
  (d) => d !== 'node_modules' && existsSync(join(pkgsDir, d, 'tsconfig.json')),
);

const memGB = (TOTAL_MEM / 1024 ** 3).toFixed(1);
console.log(
  `\n类型检查 ${pkgs.length} 个包（内存 ${memGB} GB，并发 ${CONCURRENCY}）\n`,
);

// ── 工具函数 ──────────────────────────────────────────────────────────────────
function memMB() {
  return Math.round(process.memoryUsage.rss() / 1024 / 1024);
}

function runTsc(pkg) {
  return new Promise((resolve) => {
    const start = Date.now();
    try {
      execSync(
        `npx tsc --noEmit --composite false -p packages/${pkg}/tsconfig.json`,
        { stdio: 'pipe', cwd: root },
      );
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      resolve({ pkg, ok: true, elapsed, mem: memMB() });
    } catch (err) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      const stderr = err.stderr?.toString() ?? '';
      // SIGKILL = 128 + 9 = 137 → 通常是 OOM
      const oom = err.status === 137 || /SIGKILL|out of memory/i.test(stderr);
      resolve({ pkg, ok: false, elapsed, mem: memMB(), oom, stderr });
    }
  });
}

// ── 分批执行 ──────────────────────────────────────────────────────────────────
async function runBatched() {
  const failed = [];
  const results = [];
  let batchNum = 0;

  for (let i = 0; i < pkgs.length; i += BATCH_SIZE) {
    batchNum++;
    const batch = pkgs.slice(i, i + BATCH_SIZE);
    const batchLabel =
      BATCH_SIZE > 1 ? ` [批次 ${batchNum}/${Math.ceil(pkgs.length / BATCH_SIZE)}]` : '';

    process.stdout.write(`${batchLabel} ${batch.map((p) => p.padEnd(14)).join('')} `);

    const batchResults = await Promise.all(batch.map(runTsc));
    results.push(...batchResults);

    for (const r of batchResults) {
      if (!r.ok) {
        failed.push(r);
      }
    }

    if (batchResults.every((r) => r.ok)) {
      console.log(`✓ ok (${batchResults[0]?.elapsed}s)`);
    } else {
      const tags = batchResults.map((r) => (r.ok ? '✓' : '✗')).join('');
      console.log(`✗ ${tags}`);
    }
  }

  return { failed, results };
}

// ── 入口 ──────────────────────────────────────────────────────────────────────
const { failed, results } = await runBatched();

if (failed.length) {
  console.error(`\n❌ ${failed.length} 个包类型检查失败：`);
  for (const f of failed) {
    const reason = f.oom ? '⚠️  内存不足（SIGKILL/OOM）' : '类型错误';
    console.error(`   - ${f.pkg}: ${reason}`);
  }
  console.error(
    '\n建议：\n' +
      '  1. 运行 `pnpm --filter @zh/<pkg> exec tsc --noEmit --composite false` 查看详细错误\n' +
      '  2. 如持续 OOM，降低并发：`node scripts/typecheck.mjs --concurrency 1`\n' +
      '  3. 如仅单包 OOM，单独检查该包\n',
  );
  process.exit(1);
}

// 汇总统计
const totalTime = results.reduce((s, r) => s + Number(r.elapsed), 0).toFixed(1);
console.log(`\n✅ 全部 ${pkgs.length} 个包类型检查通过（${totalTime}s）\n`);
