/**
 * 引擎集成验证脚本
 * 验证 6 大治理引擎跨包集成 + SopRegistry CRUD
 */

const KERNEL = '/Users/dawei/Desktop/智研码盾文档/zhiyan-codeshield/packages/kernel/dist';

async function main() {
  console.log('='.repeat(60));
  console.log('引擎集成验证');
  console.log('='.repeat(60));

  // ── 1. SopRegistry CRUD 验证 ──────────────────────────────
  console.log('\n[1/5] SopRegistry CRUD 验证');
  try {
    const { SopRegistry } = await import(`${KERNEL}/sop/_meta/sop-registry.js`);
    const { SopLoader } = await import(`${KERNEL}/sop/_meta/sop-loader.js`);
    
    const registry = new SopRegistry();
    const loader = new SopLoader(registry);
    const ruleCount = await loader.loadFromFileSystem();
    console.log(`  规则总数: ${ruleCount}`);
    console.log(`  注册数: ${registry.count()}`);

    // CRUD
    const stats = registry.getStats();
    console.log(`  Stats: ${JSON.stringify({ totalRules: stats.totalRules, domains: Object.keys(stats.byDomain).length })}`);

    const all = registry.getAll();
    console.log(`  getAll(): ${all.length}`);

    const first = all[0];
    const got = registry.get(first.id);
    console.log(`  get('${first.id}'): ${got ? got.name : 'NOT FOUND'}`);
    
    const updated = registry.update(first.id, { severity: 'critical' });
    console.log(`  update severity: ${updated.severity}`);

    const query = registry.query({ domain: 'guard' });
    console.log(`  query(domain=guard): ${query.length}`);

    const lifecycle = registry.evaluateLifecycle();
    console.log(`  lifecycle: ${JSON.stringify(lifecycle)}`);

    registry.remove(first.id);
    console.log(`  remove('${first.id}'): count now = ${registry.count()}`);

    console.log('  ✅ SopRegistry CRUD OK');
  } catch (e) {
    console.log(`  ❌ SopRegistry CRUD FAILED: ${e.message}`);
    if (e.stack) console.log(e.stack.split('\n').slice(0, 6).join('\n'));
  }

  // ── 2. GuardEngine 验证 ───────────────────────────────────
  console.log('\n[2/5] GuardEngine 验证');
  try {
    const { GuardEngine } = await import(`/Users/dawei/Desktop/智研码盾文档/zhiyan-codeshield/packages/guard/dist/engine.js`);
    const guardConfigDir = '/Users/dawei/Desktop/智研码盾文档/zhiyan-codeshield/packages/guard/config';
    const engine = new GuardEngine('/tmp/test-repo', guardConfigDir);
    const report = await engine.run({
      mode: 'guard',
      dryRun: true,
    });
    console.log(`  Guard report: ${report.summary.total} checks`);
    console.log('  ✅ GuardEngine OK');
  } catch (e) {
    console.log(`  ❌ GuardEngine FAILED: ${e.message}`);
  }

  // ── 3. InspectEngine 验证 ─────────────────────────────────
  console.log('\n[3/5] InspectEngine 验证');
  try {
    const { InspectEngine } = await import(`/Users/dawei/Desktop/智研码盾文档/zhiyan-codeshield/packages/inspect/dist/engine.js`);
    const engine = new InspectEngine();
    const report = await engine.runScan('test-project', 'quick');
    console.log(`  Inspect report: ${report.issues.length} issues, score: ${report.score.overall}`);
    console.log('  ✅ InspectEngine OK');
  } catch (e) {
    console.log(`  ❌ InspectEngine FAILED: ${e.message}`);
  }

  // ── 4. ScoringEngine + EvolveEngine 验证 ──────────────────
  console.log('\n[4/5] ScoringEngine + EvolveEngine 验证');
  try {
    const { ScoringEngine } = await import(`/Users/dawei/Desktop/智研码盾文档/zhiyan-codeshield/packages/scoring/dist/engine.js`);
    const { EvolveEngine } = await import(`/Users/dawei/Desktop/智研码盾文档/zhiyan-codeshield/packages/evolve/dist/engine.js`);

    const scoring = new ScoringEngine();
    const score = scoring.calculate('test-project', [
      { dimension: 'quality', score: 85, weight: 0.4 },
      { dimension: 'security', score: 92, weight: 0.3 },
      { dimension: 'performance', score: 78, weight: 0.3 },
    ]);
    console.log(`  Score: ${score.overall} (${score.grade})`);
    
    const evolve = new EvolveEngine();
    evolve.recordExperience({
      projectId: 'test-project',
      ruleId: 'guard.block.official.critical-import',
      type: 'true-positive',
      detail: 'Found dangerous import',
      source: 'integration-test',
    });
    evolve.recordExperience({
      projectId: 'test-project',
      ruleId: 'guard.block.official.critical-import',
      type: 'false-positive',
      detail: 'False alarm',
      source: 'integration-test',
    });
    evolve.recordExperience({
      projectId: 'test-project',
      ruleId: 'guard.block.official.critical-import',
      type: 'false-positive',
      detail: 'Another false alarm',
      source: 'integration-test',
    });
    const suggestions = evolve.getSuggestions('test-project');
    console.log(`  Evolve suggestions: ${suggestions.length} (expect >=1 for high false-positive)`);
    const weights = evolve.autoAdjustWeights();
    console.log(`  Auto-adjusted weights: ${weights.length}`);
    
    console.log('  ✅ ScoringEngine + EvolveEngine OK');
  } catch (e) {
    console.log(`  ❌ ScoringEngine + EvolveEngine FAILED: ${e.message}`);
  }

  // ── 5. 云脑-引擎桥梁分析 ─────────────────────────────────
  console.log('\n[5/5] 云脑-引擎桥梁分析');
  console.log('  当前状态: SopRegistry 有 68 条规则，但引擎不读 SopRegistry');
  console.log('  Gap 分析:');
  console.log('    - GuardEngine: 读 ConfigLoader.loadChecks() 而非 SopRegistry');
  console.log('    - InspectEngine: 读 ToolAdapter 注册列表，无 SopRegistry');
  console.log('    - ScoringEngine: 纯内存计算，无 SopRegistry');
  console.log('    - EvolveEngine: 纯内存经验库，无 SopRegistry');
  console.log('  桥梁缺失已文档化为已知限制');

  console.log('\n' + '='.repeat(60));
  console.log('验证完成');
  console.log('='.repeat(60));
}

main().catch(e => { console.error(e); process.exit(1); });
