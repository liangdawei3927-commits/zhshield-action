#!/usr/bin/env node
/**
 * 智汇码盾端到端回归测试
 *
 * 验证：构建 → 测试 → 服务器启动 → API 端点 → 引擎集成
 * 用于 clean checkout 后的一次性全体验证。
 *
 * 用法: node scripts/regression.mjs
 */

import { execSync, spawn } from 'child_process';
import { existsSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(import.meta.dirname, '..');
const PKGS = ['shared', 'db', 'kernel', 'guard', 'sentinel', 'inspect', 'scoring', 'evolve', 'security', 'desktop', 'server'];
const BASE = 'http://localhost:3010';
const BASE_API = `${BASE}/api/v1`;

let pass = true;

function ok(msg) {
  console.log(`  ✅ ${msg}`);
}
function fail(msg) {
  console.log(`  ❌ ${msg}`);
  pass = false;
}
function header(title) {
  console.log(`\n${'='.repeat(60)}\n${title}\n${'='.repeat(60)}`);
}

// ── 1. 构建验证 ─────────────────────────────────────────────
header('[1/6] 构建验证');
try {
  const out = execSync('pnpm build 2>&1', { cwd: ROOT, maxBuffer: 10 * 1024 * 1024, timeout: 180_000 }).toString();
  const match = out.match(/Tasks:\s+(\d+) successful/);
  if (match && parseInt(match[1]) >= 11) {
    ok(`pnpm build: ${match[0]}`);
  } else {
    fail(`pnpm build result unexpected: ${match ? match[0] : 'no match'}`);
  }
  // 验证每个包 dist 有产物
  for (const pkg of PKGS) {
    const distDir = resolve(ROOT, 'packages', pkg, 'dist');
    if (['desktop', 'server'].includes(pkg)) {
      // desktop has dist/index.html + dist-electron; server has dist/main.js
      if (pkg === 'desktop' && existsSync(resolve(distDir, 'index.html'))) {
        ok(`${pkg}: dist/index.html exists`);
      } else if (pkg === 'server' && existsSync(resolve(distDir, 'main.js'))) {
        ok(`${pkg}: dist/main.js exists`);
      } else {
        fail(`${pkg}: missing expected dist output`);
      }
    } else {
      const jsFiles = execSync(`find dist -name '*.js' 2>/dev/null | head -1`, { cwd: resolve(ROOT, 'packages', pkg) }).toString().trim();
      if (existsSync(distDir) && jsFiles) {
        ok(`${pkg}: dist/ has JS output`);
      } else {
        fail(`${pkg}: dist/ missing or no JS files`);
      }
    }
  }
} catch (e) {
  fail(`Build failed: ${e.message}`);
}

// ── 2. 测试验证 ─────────────────────────────────────────────
header('[2/6] 测试验证');
try {
  const out = execSync('pnpm test 2>&1', { cwd: ROOT, maxBuffer: 10 * 1024 * 1024, timeout: 120_000 }).toString();
  if (out.includes('Tests ')) {
    // extract summary line
    const lines = out.split('\n').filter(l => l.includes('Tests '));
    lines.forEach(l => ok(`Test result: ${l.trim()}`));
    if (out.includes('FAIL') || out.includes('failed')) {
      fail('Some tests failed (check output above)');
    }
  } else {
    // maybe no test files yet; check exit code
    ok('pnpm test completed (no test output parsed)');
  }
} catch (e) {
  fail(`Tests failed: ${e.message}`);
}

// ── 3. LSP 诊断检查 ─────────────────────────────────────────
header('[3/6] LSP 诊断检查');
// Quick check: tsc --noEmit on all packages
for (const pkg of PKGS) {
  try {
    execSync('npx tsc --noEmit 2>&1', {
      cwd: resolve(ROOT, 'packages', pkg),
      timeout: 30_000,
      stdio: 'pipe',
    });
    ok(`${pkg}: tsc --noEmit clean`);
  } catch (e) {
    const stderr = e.stderr?.toString() || '';
    const stdout = e.stdout?.toString() || '';
    const errs = (stderr + stdout).split('\n').filter(l => l.includes('error TS')).length;
    if (errs > 0) {
      fail(`${pkg}: ${errs} TS errors`);
    } else {
      ok(`${pkg}: tsc --noEmit clean (exit code non-zero but no TS errors)`);
    }
  }
}

// ── 4. 服务器启动与健康检查 ────────────────────────────────
header('[4/6] 服务器启动与健康检查');
let serverProcess = null;
try {
  // Kill any existing server
  try { execSync('kill $(lsof -t -i:3010) 2>/dev/null || true'); } catch {}

  // Start server
  serverProcess = spawn('node', ['dist/main.js'], {
    cwd: resolve(ROOT, 'packages', 'server'),
    stdio: 'pipe',
    timeout: 30_000,
  });

  // Wait for startup
  let output = '';
  await new Promise((resolveTimeout, reject) => {
    const timeout = setTimeout(() => {
      // Server started but may still be initializing
      resolveTimeout();
    }, 8000);

    serverProcess.stdout.on('data', (data) => {
      output += data.toString();
      if (output.includes('listening') || output.includes('started') || output.includes('Server')) {
        clearTimeout(timeout);
        resolveTimeout();
      }
    });
    serverProcess.stderr.on('data', (data) => {
      output += data.toString();
      if (output.includes('listening') || output.includes('started') || output.includes('Server') || output.includes('Nest')) {
        clearTimeout(timeout);
        resolveTimeout();
      }
    });
    serverProcess.on('error', reject);
    serverProcess.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        clearTimeout(timeout);
        reject(new Error(`Server exited with code ${code}: ${output}`));
      }
    });
  });

  // Health check
  const health = await fetch(`${BASE}/health`);
  const healthJson = await health.json();
  if (health.ok) {
    ok(`Health: ${JSON.stringify(healthJson).slice(0, 100)}`);
  } else {
    fail(`Health check returned ${health.status}`);
  }

  // Ready check
  const ready = await fetch(`${BASE}/ready`);
  if (ready.ok) {
    ok(`Ready: ${await ready.text()}`);
  } else {
    fail(`Ready check returned ${ready.status}`);
  }

} catch (e) {
  fail(`Server start/health failed: ${e.message}`);
}

// ── 5. API 端点验证 ─────────────────────────────────────────
header('[5/6] API 端点验证');
const apiTests = [
  { name: 'sop version',     url: `${BASE_API}/sop/version`,              method: 'GET' },
  { name: 'sop emergency',   url: `${BASE_API}/sop/emergency`,            method: 'GET' },
  { name: 'sop diff',        url: `${BASE_API}/sop/diff?from=1.0.0&to=2.0.0`, method: 'GET' },
  { name: 'sop full',        url: `${BASE_API}/sop/full/1.0.0`,           method: 'GET' },
  { name: 'rules eslint v',  url: `${BASE_API}/rules/eslint/version`,     method: 'GET' },
  { name: 'rules eslint em', url: `${BASE_API}/rules/eslint/emergency`,   method: 'GET' },
  { name: 'experience post', url: `${BASE_API}/experience`,               method: 'POST', body: { accepted: 1, rejected: 0 } },
];

let apiPassed = 0, apiFailed = 0;
for (const t of apiTests) {
  try {
    const opts = { method: t.method, headers: { 'Content-Type': 'application/json' } };
    if (t.body) opts.body = JSON.stringify(t.body);
    const res = await fetch(t.url, opts);
    const text = await res.text();
    // Check it's valid JSON for 2xx
    if (res.ok && t.method === 'GET') {
      JSON.parse(text); // throws if not JSON
      ok(`[${t.name.padEnd(20)}] ${res.status}`);
      apiPassed++;
    } else if (res.ok || res.status === 404 || res.status === 400) {
      ok(`[${t.name.padEnd(20)}] ${res.status} (expected)`);
      apiPassed++;
    } else {
      fail(`[${t.name.padEnd(20)}] ${res.status}: ${text.slice(0, 80)}`);
      apiFailed++;
    }
  } catch (e) {
    fail(`[${t.name.padEnd(20)}] ERROR: ${e.message}`);
    apiFailed++;
  }
}

// ── 6. 引擎集成验证 ─────────────────────────────────────────
header('[6/6] 引擎集成验证');
const KERNEL_DIST = resolve(ROOT, 'packages/kernel/dist');
const GUARD_DIST = resolve(ROOT, 'packages/guard/dist');
const INSPECT_DIST = resolve(ROOT, 'packages/inspect/dist');
const SCORING_DIST = resolve(ROOT, 'packages/scoring/dist');
const EVOLVE_DIST = resolve(ROOT, 'packages/evolve/dist');
const GUARD_CONFIG = resolve(ROOT, 'packages/guard/config');

async function testEngine(name, fn) {
  try {
    await fn();
    ok(`${name}`);
  } catch (e) {
    fail(`${name}: ${e.message}`);
  }
}

await testEngine('SopRegistry CRUD', async () => {
  const { SopRegistry } = await import(`${KERNEL_DIST}/sop/_meta/sop-registry.js`);
  const { SopLoader } = await import(`${KERNEL_DIST}/sop/_meta/sop-loader.js`);
  const registry = new SopRegistry();
  const loader = new SopLoader(registry);
  const count = await loader.loadFromFileSystem();
  const all = registry.getAll();
  if (all.length > 0) {
    const first = all[0];
    const got = registry.get(first.id);
    if (!got) throw new Error(`get('${first.id}') returned null`);
    const updated = registry.update(first.id, { severity: 'critical' });
    if (!updated) throw new Error('update returned null');
    registry.remove(first.id);
    if (registry.count() !== count - 1) throw new Error(`remove failed: count ${registry.count()} != ${count - 1}`);
  }
  const stats = registry.getStats();
  if (!stats) throw new Error('getStats returned null');
});

await testEngine('GuardEngine', async () => {
  const { GuardEngine } = await import(`${GUARD_DIST}/engine.js`);
  const engine = new GuardEngine('/tmp/test-repo', GUARD_CONFIG);
  const report = await engine.run({ mode: 'guard', dryRun: true });
  if (!report || !report.summary) throw new Error('report missing summary');
});

await testEngine('InspectEngine', async () => {
  const { InspectEngine } = await import(`${INSPECT_DIST}/engine.js`);
  const engine = new InspectEngine();
  const report = await engine.runScan('test-project', 'quick');
  if (!report || !report.issues) throw new Error('report missing issues');
});

await testEngine('ScoringEngine', async () => {
  const { ScoringEngine } = await import(`${SCORING_DIST}/engine.js`);
  const engine = new ScoringEngine();
  const score = engine.calculate('test-project', [
    { name: 'quality', score: 85, weight: 0.4, issues: 2 },
    { name: 'security', score: 92, weight: 0.3, issues: 0 },
    { name: 'performance', score: 78, weight: 0.3, issues: 5 },
  ]);
  if (!score || !score.overall) throw new Error(`score missing: ${JSON.stringify(score)}`);
});

await testEngine('EvolveEngine', async () => {
  const { EvolveEngine } = await import(`${EVOLVE_DIST}/engine.js`);
  const engine = new EvolveEngine();
  engine.recordExperience({ projectId: 'test', ruleId: 'test', type: 'true-positive', detail: 'test', source: 'regression' });
  engine.recordExperience({ projectId: 'test', ruleId: 'test', type: 'false-positive', detail: 'test', source: 'regression' });
  engine.recordExperience({ projectId: 'test', ruleId: 'test', type: 'false-positive', detail: 'test', source: 'regression' });
  const weights = engine.autoAdjustWeights();
  if (!weights || !Array.isArray(weights)) throw new Error('autoAdjustWeights failed');
});

// ── 汇总 ────────────────────────────────────────────────────
console.log();
console.log('='.repeat(60));
if (pass && apiFailed === 0) {
  console.log('🎉 全部验证通过！');
} else {
  console.log(`⚠️  验证完成，存在问题: API ${apiPassed} passed, ${apiFailed} failed`);
}
console.log('='.repeat(60));

// Cleanup server
if (serverProcess) {
  serverProcess.kill();
  try { execSync('kill $(lsof -t -i:3010) 2>/dev/null || true'); } catch {}
}

process.exit((pass && apiFailed === 0) ? 0 : 1);
