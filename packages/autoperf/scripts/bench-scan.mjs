// AutoPerf 基准扫描脚本：对给定路径运行 engine.scan，打印探测耗时与 Issue。
// 用法：node packages/autoperf/scripts/bench-scan.mjs [path]
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AutoPerfEngine } = require('@zh/autoperf');

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const target = process.argv[2] ? resolve(process.argv[2]) : repoRoot;

const engine = new AutoPerfEngine();
const profile = engine.getMachineProfile();
console.log(
  `机器画像: ${profile.cores} 核 / ${profile.totalMemGb}GB 内存 / 低配=${profile.lowMemory}`,
);
console.log(`扫描路径: ${target}\n`);

const report = await engine.scan({ projectPath: target });

console.log('── 探测结果 ──');
for (const probe of report.probes) {
  const meta = probe.metadata ? ` ${JSON.stringify(probe.metadata)}` : '';
  console.log(`  ${probe.probeName.padEnd(18)} ${probe.elapsedMs}ms${meta}`);
}

console.log(`\n── Issue（${report.issues.length}）──`);
for (const issue of report.issues) {
  console.log(`  [${issue.severity}] ${issue.ruleId} — ${issue.message}`);
}
if (report.issues.length === 0) {
  console.log('  无超预算问题，性能达标。');
}
