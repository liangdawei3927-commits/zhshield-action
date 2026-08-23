import { describe, expect, it } from 'vitest';
import { buildHealthDimensions } from '../pipeline-score';
import { ScoringEngine } from '../engine';
import type { ProjectProfile } from '@zh/profiler';

/** 最小测试画像 */
function makeProfile(type: ProjectProfile['type']): ProjectProfile {
  return {
    version: '1.0.0',
    projectRoot: '/test',
    language: 'typescript',
    secondaryLanguages: [],
    framework: 'nestjs',
    type,
    runtime: 'node',
    packageManager: 'pnpm',
    isMonorepo: false,
    detectedFiles: [],
    confidence: 0.8,
    detectedAt: new Date(),
    signals: [],
  };
}

const guardPass = { results: [] as Array<{ severity: 'error' | 'warning' | 'info'; status: 'passed' | 'failed' | 'error' | 'warning'; blocking: boolean }> };

describe('画像驱动评分 — 端到端整体分异构区分（回归）', () => {
  it('完全相同的报告：安全问题时 backend 整体分 < frontend（backend 更看重 security）', () => {
    const inspect = {
      issues: [
        { severity: 'error' as const, category: 'security' },
        { severity: 'error' as const, category: 'security' },
        { severity: 'warning' as const, category: 'quality' },
      ],
    };
    const guard = { results: [{ severity: 'error' as const, status: 'failed' as const, blocking: true }] };

    const backend = new ScoringEngine().calculate('p', buildHealthDimensions(guard, inspect, undefined, makeProfile('backend')));
    const frontend = new ScoringEngine().calculate('p', buildHealthDimensions(guard, inspect, undefined, makeProfile('frontend')));

    expect(backend.overall).toBeLessThan(frontend.overall);
  });

  it('质量问题时整体分关系反转（frontend < backend），证明不是单调偏移', () => {
    const inspect = {
      issues: [
        { severity: 'warning' as const, category: 'security' },
        { severity: 'error' as const, category: 'quality' },
        { severity: 'error' as const, category: 'quality' },
      ],
    };
    const backend = new ScoringEngine().calculate('p', buildHealthDimensions(guardPass, inspect, undefined, makeProfile('backend')));
    const frontend = new ScoringEngine().calculate('p', buildHealthDimensions(guardPass, inspect, undefined, makeProfile('frontend')));

    expect(frontend.overall).toBeLessThan(backend.overall);
  });

  it('无 issue 时各类型整体分均接近满分且基本一致（区分只在有问题时出现）', () => {
    const inspect = { issues: [] };
    const scores: Record<string, number> = {};
    for (const type of ['backend', 'frontend', 'app', 'mini-program', 'desktop', 'library', 'cli'] as const) {
      const r = new ScoringEngine().calculate('p', buildHealthDimensions(guardPass, inspect, undefined, makeProfile(type)));
      scores[type] = r.overall;
      expect(r.overall).toBeGreaterThanOrEqual(99);
    }
    // 全部满分，类型间不应有实质差异
    const values = Object.values(scores);
    expect(Math.max(...values) - Math.min(...values)).toBeLessThan(0.01);
  });

  it('不传 profile 与 backend（空增量）整体分一致（向后兼容）', () => {
    const inspect = {
      issues: [
        { severity: 'error' as const, category: 'security' },
        { severity: 'error' as const, category: 'quality' },
      ],
    };
    const noProfile = new ScoringEngine().calculate('p', buildHealthDimensions(guardPass, inspect));
    const backend = new ScoringEngine().calculate('p', buildHealthDimensions(guardPass, inspect, undefined, makeProfile('backend')));
    expect(noProfile.overall).toBeCloseTo(backend.overall, 2);
  });
});
