#!/usr/bin/env node
/**
 * SOP 巡检口径验证（P0-2）：与桌面端 createLoadedRunner 相同装载顺序
 * （内置模板 + ZH_SOP_CACHE_DIR 云同步缓存，REMOTE_WINS 按 id 覆盖内置），
 * 校验云规则真实生效；可选全量扫描输出各报告规则命中数。
 *
 * 用法：
 *   node packages/desktop/scripts/verify-sop-scan.mjs [--scan] [projectPath]
 *
 * 默认 projectPath = process.cwd()；缓存目录取 $ZH_SOP_CACHE_DIR，
 * 未设置回退 macOS 桌面 userData 默认路径。云同步规则数为 0 时退出码 1
 * （防止"只测内置模板就误判已修复"——线上报告走的是云规则口径）。
 */
import { PipelineRunner } from '@zh/pipeline';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const args = process.argv.slice(2);
const wantScan = args.includes('--scan');
const projectPath = args.find((a) => a !== '--scan') ?? process.cwd();

function defaultCacheDir() {
  if (process.platform !== 'darwin') return null;
  return path.join(
    os.homedir(),
    'Library',
    'Application Support',
    '@zh',
    'desktop',
    'sop-cache',
  );
}

const cacheDir = process.env.ZH_SOP_CACHE_DIR ?? defaultCacheDir();

const runner = new PipelineRunner(projectPath);
const builtin = await runner.loadSopRules();

let synced = 0;
if (cacheDir && fs.existsSync(cacheDir)) {
  synced = await runner.loadSopRulesFromCache(cacheDir);
} else {
  console.warn(
    `[cache] 缓存目录不可用: ${cacheDir ?? '(非 macOS，未设置 ZH_SOP_CACHE_DIR)'} → 仅内置模板，与线上报告口径不一致`,
  );
}

console.log(`[ruleset] 内置模板: ${builtin} 条`);
console.log(`[ruleset] 云同步: ${synced} 条${synced === 0 ? ' ← 口径不完整' : ''}`);
console.log(`[ruleset] ${synced > 0 ? '口径 OK：与桌面 createLoadedRunner 一致（REMOTE_WINS 生效）' : '口径 FAIL：云规则未加载，验证结论对线上报告无效'}`);

if (!wantScan || synced === 0) {
  process.exit(synced > 0 ? 0 : 1);
}

const t0 = Date.now();
const report = await runner.runInspect();
const issues = report.issues ?? [];
console.log(`\n[scan] 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s，总 issue 数: ${issues.length}`);

const byRule = new Map();
for (const it of issues) {
  const key = it.ruleId ?? it.id ?? 'unknown';
  byRule.set(key, (byRule.get(key) ?? 0) + 1);
}
console.log('\n[scan] 各规则命中数:');
for (const [k, v] of [...byRule.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k}: ${v}`);
}

const TARGETS = [
  'type-consistency',
  'duplication',
  'code-vulnerability',
  'dependency-audit',
  'eslint-performance',
  'path-traversal',
  'type-definitions',
  'type-safety',
];
console.log('\n[scan] 对照 8 类报告规则:');
for (const t of TARGETS) {
  const hit = issues.filter(
    (it) => (it.ruleId ?? '').includes(t) || (it.id ?? '').includes(t),
  );
  console.log(`  ${t}: ${hit.length}`);
  for (const h of hit.slice(0, 3)) {
    console.log(
      `      ${h.file}:${h.line ?? h.startLoc?.line ?? ''} ${(h.message ?? '').slice(0, 50)}`,
    );
  }
}

process.exit(0);