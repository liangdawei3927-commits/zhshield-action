// 临时验证脚本：用新 dist 重跑 guard，检查 typescript-error 是否消解
import { PipelineRunner } from './dist/index.js';

const projectPath = '/Users/dawei/Desktop/ZHCodeShield/zhiyan-codeshield';
const runner = new PipelineRunner(projectPath);
await runner.loadSopRules();

const report = await runner.runSopGuard();
console.log(`GUARD total=${report.total} passed=${report.passed} failed=${report.failed} errors=${report.errors} skipped=${report.skipped} ok=${report.ok}`);

for (const ev of report.evaluations) {
  const ruleId = ev.rule?.id ?? ev.rule?.meta?.id ?? '?';
  const files = ev.files?.length ?? 0;
  const v = ev.violations?.length ?? 0;
  console.log(`  [${ev.status}] ${ruleId}  files=${files} violations=${v}`);
  if (ev.status === 'failed' && ev.violations?.length) {
    for (const vi of ev.violations.slice(0, 6)) {
      console.log(`      - ${vi.file ?? ''} ${vi.message ?? JSON.stringify(vi).slice(0, 100)}`);
    }
    if (ev.violations.length > 6) console.log(`      ... (+${ev.violations.length - 6} more)`);
  } else if (ev.status === 'failed' && ev.message) {
    console.log(`      msg: ${ev.message.slice(0, 160)}`);
  }
}

await runner.destroy();
