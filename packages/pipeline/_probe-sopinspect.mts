import { PipelineRunner } from './src/pipeline-runner';

async function main() {
  const runner = new PipelineRunner('/Users/dawei/Desktop/ZHCodeShield/zhihui-codeshield/zhihui-codeshield');
  await runner.loadSopRules();
  const report = await runner.runSopInspect({ domains: ['inspect'] });
  console.log('summary:', JSON.stringify(report.summary));
  const viols: Array<{ ruleId: string; file?: string; line?: number; column?: number; message?: string }> = [];
  for (const ev of report.evaluations) {
    for (const v of ev.violations ?? []) {
      viols.push({ ruleId: ev.rule?.id ?? v.ruleId ?? '?', file: v.file, line: v.line, column: v.column, message: v.message });
    }
  }
  console.log('total violations:', viols.length);
  const byId: Record<string, number> = {};
  for (const v of viols) byId[v.ruleId] = (byId[v.ruleId] ?? 0) + 1;
  console.log('ruleId 分布:', JSON.stringify(byId, null, 0));
  const pt = viols.filter((v) => String(v.ruleId).includes('path-traversal'));
  console.log('path-traversal violations:', JSON.stringify(pt, null, 1).slice(0, 1500));
  const raw = report['rawViolations'];
  const kept = report['keptViolations'];
  console.log('原始/保留 violation 计数:', raw, '/', kept);
}

main().catch((e) => { console.error(e); process.exit(1); });
