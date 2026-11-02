import { describe, it, expect, vi } from 'vitest';
import type { Vulnerability, GarbageItem, MalwareItem } from '../types';
import type { VulnerabilityScanner } from '../vulnerability-scanner';
import { ResultAggregator } from '../engine-result-aggregator';
import { GrypeCrossValidator } from '../cross-validator';
import { RuleConflictResolver } from '../rule-conflict-resolver';

function makeAggregator(vulnScan: () => Promise<Vulnerability[]>, garbageScan: () => Promise<GarbageItem[]>) {
  const malwareScanner = { scan: async (): Promise<MalwareItem[]> => [] };
  return new ResultAggregator(
    { scan: vulnScan } as unknown as VulnerabilityScanner,
    garbageScan,
    malwareScanner as unknown as ConstructorParameters<typeof ResultAggregator>[2],
    new GrypeCrossValidator(),
    new RuleConflictResolver(),
  );
}

const baseParams = {
  projectPath: '/tmp/proj',
  depcheckIssues: [],
  semgrepIssues: [],
  trivyIssues: [],
  grypeIssues: [],
};

describe('ResultAggregator — 依赖域 Owner 结论的收集范围（C3 / O2 / O7）', () => {
  it('includeDependencyOwned=false 时不重扫依赖 CVE 与未使用依赖（不产生任何依赖类结论）', async () => {
    // 意图：安全域不是依赖 CVE（deps）与未使用依赖（garbage）的 Owner，
    // 域内扫描若仍调 pnpm audit / depcheck，既重复计分（C2）又重复扫（C3）。
    const vulnScan = vi.fn(async () => [{ id: 'v1' } as Vulnerability]);
    const garbageScan = vi.fn(async () => [{ id: 'g1' } as GarbageItem]);
    const aggregator = makeAggregator(vulnScan, garbageScan);

    const result = await aggregator.collect({ ...baseParams, includeDependencyOwned: false });

    expect(result.vulnerabilities).toEqual([]);
    expect(result.garbage).toEqual([]);
    expect(vulnScan).not.toHaveBeenCalled();
    expect(garbageScan).not.toHaveBeenCalled();
  });

  it('includeDependencyOwned=true 保留安全中心完整报告口径（CVE 与未使用依赖照旧入库）', async () => {
    const vulnScan = vi.fn(async () => [{ id: 'v1' } as Vulnerability]);
    const garbageScan = vi.fn(async () => [{ id: 'g1' } as GarbageItem]);
    const aggregator = makeAggregator(vulnScan, garbageScan);

    const result = await aggregator.collect({ ...baseParams, includeDependencyOwned: true });

    expect(result.vulnerabilities).toHaveLength(1);
    expect(result.garbage).toHaveLength(1);
    expect(vulnScan).toHaveBeenCalledTimes(1);
    expect(garbageScan).toHaveBeenCalledTimes(1);
  });
});
