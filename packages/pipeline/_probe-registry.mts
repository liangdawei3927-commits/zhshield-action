import { PipelineRunner } from './src/pipeline-runner';

async function main() {
  const runner = new PipelineRunner('/Users/dawei/Desktop/ZHCodeShield/zhihui-codeshield/zhihui-codeshield');
  await runner.loadSopRules();
  const all = runner['sopRegistry'].getAll() as Array<{ id: string; active?: boolean; status?: string }>;
  console.log('TOTAL:', all.length);
  const inspect = all.filter((r) => r.id.startsWith('inspect.'));
  const security = all.filter((r) => r.id.startsWith('security.'));
  console.log('INSPECT DOMAIN:', inspect.length);
  inspect.forEach((r) => console.log('  ', r.id, r.active ? '' : '(inactive)'));
  console.log('SECURITY DOMAIN:', security.length);
  security.forEach((r) => console.log('  ', r.id, r.active ? '' : '(inactive)'));
  console.log('PATH-TRAVERSAL-like:', all.filter((r) => r.id.includes('path-traversal')).map((r) => r.id));
}

main().catch((e) => { console.error(e); process.exit(1); });
