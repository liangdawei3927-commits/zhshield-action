#!/usr/bin/env node
/**
 * A15 验收：漏洞库不可达 → "未检测"，且不得折算成 0 漏洞
 *
 * 为什么需要端到端（而不是继续用单测）：单测注入的是假 fetch，证明的是
 * "函数拿到错误会返回 unavailable"；它证明不了**构建产物 + 真实网络栈 + 域驱动 +
 * 退出码**这一整条链。A15 因此长期只能勾半个（在线成功验过，"不可达"那侧没验过）。
 *
 * 现在能验的前提：OSV 端点可经 `ZH_OSV_BASE_URL` 覆盖（`deps-cve.ts`），
 * 于是"断网"可以在不拔网线、不改产品默认值的情况下复现。三种场景互为对照，
 * 防止"永远 unavailable"这种假通过也能过验收：
 *
 *   stub     本地桩返回 1 条高危 → deps `ok`、发现 1 条、exit 0（正向对照：验得出来）
 *   refused  连接被拒（等价断网）→ deps `partial`、cve `unavailable`、exit 2
 *   timeout  桩只连不应答 → 8s 硬超时 → deps `partial`、cve `unavailable`、exit 2
 *
 * 三个都过才 PASS：只有 refused/timeout 过，可能把"永远查不到"当成正确；
 * 只有 stub 过，则证明不了降级。缺一不可。
 *
 * 用法：
 *   node scripts/verify-offline-deps.mjs              # 三种场景全跑（约 10–20s）
 *   node scripts/verify-offline-deps.mjs --mode refused
 *
 * 退出码：0 PASS / 1 FAIL / 3 环境错误
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'packages/cli/dist/zhshield.js');
const FIXTURE = path.join(ROOT, 'scripts/fixtures/deps-offline');
const MODES = ['stub', 'refused', 'timeout'];

function parseArgs(argv) {
  const args = { mode: 'all' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mode') args.mode = argv[++i] ?? 'all';
    else if (a === '--help' || a === '-h') {
      console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
      process.exit(0);
    } else {
      console.error(`未知参数: ${a}`);
      process.exit(3);
    }
  }
  if (args.mode !== 'all' && !MODES.includes(args.mode)) {
    console.error(`--mode 只支持: all | ${MODES.join(' | ')}`);
    process.exit(3);
  }
  return args;
}

/** 拿一个"确定没人监听"的端口：绑 0 拿号后立刻关掉 */
function closedPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** 本地桩：querybatch 返回 1 条命中，详情返回高危 —— 用来做"验得出来"的正向对照 */
function startStubServer() {
  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    if (url.includes('/v1/querybatch')) {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ results: [{ vulns: [{ id: 'GHSA-zhsh-0001-0001' }] }] }));
      });
      return;
    }
    if (url.includes('/v1/vulns/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'GHSA-zhsh-0001-0001',
          aliases: ['CVE-2021-23337'],
          summary: 'stub: command injection',
          database_specific: { severity: 'HIGH' },
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end('nf');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/** 挂起桩：接受连接但永不应答 —— 触发 8s 硬超时路径（与真实"网络黑洞"同形） */
function startHangServer() {
  const server = http.createServer(() => {
    // 故意不响应：客户端应被自己的 AbortController 掐断
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function runCli(baseUrl) {
  const ledgerPath = path.join(os.tmpdir(), `zhshield-offline-${process.pid}-${Date.now()}.json`);
  fs.rmSync(ledgerPath, { force: true });
  const cliArgs = [
    DIST,
    'pipeline',
    '--full',
    '--domains',
    'deps',
    '--dir',
    FIXTURE,
    '--format',
    'json',
    '--report',
    ledgerPath,
  ];
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, cliArgs, {
      cwd: FIXTURE,
      env: { ...process.env, ZH_OSV_BASE_URL: baseUrl, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stdout.on('data', () => {});
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('close', (code) => {
      let ledger = null;
      try {
        ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
      } catch {
        // 无账本 → 断言会以"未读到账本"失败，而不是把空结果当通过
      }
      fs.rmSync(ledgerPath, { force: true });
      resolve({ exitCode: code, elapsedMs: Date.now() - startedAt, ledger, stderr });
    });
  });
}

function depsRecord(ledger) {
  return ledger?.records?.find((record) => record.domain === 'deps') ?? null;
}

/** 断言集合：返回失败原因数组（空 = 通过） */
function assertScenario(scenario, result) {
  const failures = [];
  const record = depsRecord(result.ledger);
  if (!result.ledger) {
    failures.push('未读到账本（--format json --report 未落盘）');
    return failures;
  }
  if (result.ledger.records.length !== 1 || !record) {
    failures.push(
      `账本应只含 deps 一域，实际 ${result.ledger.records.map((r) => r.domain).join(',')}`,
    );
    return failures;
  }
  const cve = record.report?.cve;

  if (scenario === 'stub') {
    if (result.exitCode !== 0) failures.push(`期望 exit 0，实际 ${result.exitCode}`);
    if (record.status !== 'ok') failures.push(`期望 deps ok，实际 ${record.status}`);
    if (cve?.status !== 'ok') failures.push(`期望 cve ok，实际 ${cve?.status}`);
    if ((cve?.findings?.length ?? 0) !== 1)
      failures.push(`期望 1 条 CVE，实际 ${cve?.findings?.length}`);
    if (!String(cve?.findings?.[0]?.ids ?? '').includes('CVE-2021-23337')) {
      failures.push('CVE 别名未补全（详情补拉未生效）');
    }
    return failures;
  }

  // refused / timeout：不可达必须显形，且不得退化成 0 漏洞的"干净"
  if (result.exitCode !== 2) failures.push(`期望 exit 2（未检测 ≠ 通过），实际 ${result.exitCode}`);
  if (record.status !== 'partial') failures.push(`期望 deps partial，实际 ${record.status}`);
  if (cve?.status !== 'unavailable') failures.push(`期望 cve unavailable，实际 ${cve?.status}`);
  if (!cve?.reason) failures.push('cve 降级未带原因（用户无法判断为什么没查）');
  if ((cve?.findings?.length ?? 0) !== 0)
    failures.push(`不可达时不应有 findings，实际 ${cve?.findings?.length}`);
  if (scenario === 'timeout' && !String(cve?.reason ?? '').includes('超时')) {
    failures.push(`超时场景 reason 不含"超时"：${cve?.reason}`);
  }
  if (!String(record.reason ?? '').includes('依赖 CVE 未检测')) {
    failures.push(`域级 reason 未标注"依赖 CVE 未检测"：${record.reason}`);
  }
  return failures;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(DIST)) {
    console.error(`❌ 构建产物不存在：${DIST}\n   先跑 pnpm --filter zhshield-cli build`);
    process.exit(3);
  }
  if (!fs.existsSync(path.join(FIXTURE, 'package-lock.json'))) {
    console.error(`❌ 夹具缺锁文件：${FIXTURE}`);
    process.exit(3);
  }

  const scenarios = args.mode === 'all' ? MODES : [args.mode];
  console.log('A15 断网端到端验收（构建产物 + 真实网络栈 + 域驱动 + 退出码）');
  console.log(`  夹具：${path.relative(ROOT, FIXTURE)}（lodash@4.17.20，无源码 → deps 单域几秒）`);

  const results = [];
  for (const scenario of scenarios) {
    let server = null;
    let baseUrl;
    if (scenario === 'stub') {
      const started = await startStubServer();
      server = started.server;
      baseUrl = `http://127.0.0.1:${started.port}`;
    } else if (scenario === 'timeout') {
      const started = await startHangServer();
      server = started.server;
      baseUrl = `http://127.0.0.1:${started.port}`;
    } else {
      baseUrl = `http://127.0.0.1:${await closedPort()}`;
    }

    const result = await runCli(baseUrl);
    if (server) server.close();
    const failures = assertScenario(scenario, result);
    const record = depsRecord(result.ledger);
    results.push({
      scenario,
      baseUrl,
      exitCode: result.exitCode,
      elapsedMs: result.elapsedMs,
      domainStatus: record?.status ?? null,
      cveStatus: record?.report?.cve?.status ?? null,
      cveReason: record?.report?.cve?.reason ?? null,
      findings: record?.report?.cve?.findings?.length ?? null,
      failures,
    });

    const mark = failures.length === 0 ? '✅' : '❌';
    console.log(
      `  ${mark} ${scenario.padEnd(7)} exit=${result.exitCode} ` +
        `deps=${record?.status ?? '-'} cve=${record?.report?.cve?.status ?? '-'} ` +
        `(${(result.elapsedMs / 1000).toFixed(2)}s)`,
    );
    if (record?.report?.cve?.reason) console.log(`      reason: ${record.report.cve.reason}`);
    for (const failure of failures) console.log(`      ✗ ${failure}`);
  }

  const failed = results.filter((r) => r.failures.length > 0);
  const artifact = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    target: 'A15',
    criterion:
      '漏洞库不可达 → 域 partial + cve unavailable（带原因）+ exit 2；在线可达时能验出 CVE',
    verdict: failed.length === 0 ? 'PASS' : 'FAIL',
    command: `node scripts/verify-offline-deps.mjs --mode ${args.mode}`,
    results,
  };
  const outPath = path.join(ROOT, '.zhshield', 'bench', `offline-deps-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  console.log(`\n  账本: ${path.relative(ROOT, outPath)}`);

  if (failed.length > 0) {
    console.log(`❌ FAIL — ${failed.length}/${results.length} 个场景未通过`);
    process.exit(1);
  }
  console.log(`✅ PASS — ${results.length} 个场景全部符合 A15 判据`);
  process.exit(0);
}

main().catch((err) => {
  console.error('验收脚本异常:', err);
  process.exit(3);
});
