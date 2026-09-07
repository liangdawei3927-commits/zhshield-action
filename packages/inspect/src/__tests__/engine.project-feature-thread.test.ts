import { describe, it, expect, vi } from 'vitest';

import { InspectEngine } from '../engine';
import { SopRuleEngine, SopRegistry } from '@zh/kernel';
import type { RuleEngineReport } from '@zh/kernel';

/**
 * R3d 画像贯通链测试（spec §2.3 ⑦⑧）：runScan 第三参 projectFeature
 * → runScanWithSop → evaluateRules 收到 projectFeature。
 * 此前 runScanWithSop 的两个 evaluateRules context 均不携带 projectFeature
 * → host.toolScope 恒 undefined → SOP tool-dispatch 裁剪永不触发。
 * 本组用例钉死贯通链：带画像 → 两域 context 均收到；无画像 → 不携带（回归安全）。
 */
function makeEmptyReport(): RuleEngineReport {
  return {
    total: 0,
    passed: 0,
    failed: 0,
    errors: 0,
    skipped: 0,
    ok: true,
    evaluations: [],
    durationMs: 0,
    timestamp: new Date(),
  };
}

describe('InspectEngine — R3d 画像贯通（runScan → runScanWithSop → evaluateRules 收到 projectFeature）', () => {
  it('⑦ runScan 第三参带画像 → inspect/security 两域 evaluateRules 均收到 projectFeature', async () => {
    const registry = new SopRegistry();
    const sop = new SopRuleEngine(registry);
    const spy = vi.spyOn(sop, 'evaluateRules').mockResolvedValue(makeEmptyReport());
    const engine = new InspectEngine();
    engine.useSopEngine(sop);

    await engine.runScan('proj-1', 'full', { language: 'typescript', features: [] });

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        repoRoot: 'proj-1',
        domain: 'inspect',
        projectFeature: { language: 'typescript', features: [] },
      }),
    );
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        repoRoot: 'proj-1',
        domain: 'security',
        projectFeature: { language: 'typescript', features: [] },
      }),
    );
  });

  it('⑧ 不传画像 → evaluateRules 不携带 projectFeature（无画像不裁，回归安全）', async () => {
    const registry = new SopRegistry();
    const sop = new SopRuleEngine(registry);
    const spy = vi.spyOn(sop, 'evaluateRules').mockResolvedValue(makeEmptyReport());
    const engine = new InspectEngine();
    engine.useSopEngine(sop);

    await engine.runScan('proj-1', 'full');

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ repoRoot: 'proj-1', domain: 'inspect' }),
    );
    expect(spy).not.toHaveBeenCalledWith(
      expect.objectContaining({ projectFeature: expect.anything() }),
    );
  });
});