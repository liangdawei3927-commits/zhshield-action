import { describe, expect, it } from 'vitest';
import {
  bucketFindingsByModule,
  scoreProjectModules,
  scoreProjectByModules,
} from '../module-score';
import type { ScoringProjectProfile } from '@zh/fingerprint';

function makeProfile(type: ScoringProjectProfile['type']): ScoringProjectProfile {
  return {
    version: '1.0.0',
    projectRoot: '/p',
    language: 'typescript',
    secondaryLanguages: [],
    framework: 'nestjs',
    type,
    runtime: 'node',
    packageManager: 'pnpm',
    isMonorepo: true,
    detectedFiles: [],
    confidence: 0.8,
    detectedAt: new Date(),
    signals: [],
    modules: [
      { path: '/p/packages/server', language: 'typescript', framework: 'nestjs', type: 'backend' },
      { path: '/p/packages/web', language: 'typescript', framework: 'react', type: 'frontend' },
    ],
  };
}

const emptyGuard = {
  results: [] as Array<{
    severity: 'error' | 'warning' | 'info';
    status: 'passed' | 'failed' | 'error' | 'warning';
    blocking: boolean;
    file?: string;
  }>,
};
const emptyInspect = {
  issues: [] as Array<{ severity: 'error' | 'warning' | 'info'; category: string; file?: string }>,
};

describe('bucketFindingsByModule — 按模块目录分桶', () => {
  it('findings 按 file 前缀落入对应子模块，未命中的归入根级兜底模块', () => {
    const profile = makeProfile('backend');
    const guard = {
      results: [
        {
          severity: 'error' as const,
          status: 'failed' as const,
          blocking: true,
          file: '/p/packages/server/a.ts',
        },
        {
          severity: 'warning' as const,
          status: 'warning' as const,
          blocking: false,
          file: '/p/packages/web/b.ts',
        },
        {
          severity: 'info' as const,
          status: 'passed' as const,
          blocking: false,
          file: '/p/README.md',
        },
      ],
    };
    const inspect = {
      issues: [] as Array<{
        severity: 'error' | 'warning' | 'info';
        category: string;
        file?: string;
      }>,
    };

    const bucketed = bucketFindingsByModule(profile, guard, inspect);
    const server = bucketed.find((m) => m.path === '/p/packages/server')!;
    const web = bucketed.find((m) => m.path === '/p/packages/web')!;
    const root = bucketed.find((m) => m.path === '/p')!;

    expect(server.guard.results).toHaveLength(1);
    expect(web.guard.results).toHaveLength(1);
    expect(root.guard.results).toHaveLength(1);
    expect(bucketed).toHaveLength(3); // 2 子模块 + 1 根兜底
  });

  it('非 monorepo（无 modules）只产生根级单模块', () => {
    const profile: ProjectProfile = {
      ...makeProfile('backend'),
      isMonorepo: false,
      modules: undefined,
    };
    const bucketed = bucketFindingsByModule(profile, emptyGuard, emptyInspect);
    expect(bucketed).toHaveLength(1);
    expect(bucketed[0].path).toBe('/p');
  });
});

describe('scoreProjectModules — 模块独立评分 + 聚合', () => {
  it('各模块按其类型权重独立评分，整体分为等权平均', () => {
    const backend = {
      path: '/p/packages/server',
      profile: makeProfile('backend'),
      guard: {
        results: [
          {
            severity: 'error' as const,
            status: 'failed' as const,
            blocking: true,
            file: '/p/packages/server/a.ts',
          },
        ],
      },
      inspect: {
        issues: [
          { severity: 'error' as const, category: 'security', file: '/p/packages/server/a.ts' },
          { severity: 'error' as const, category: 'security', file: '/p/packages/server/a.ts' },
        ],
      },
    };
    const frontend = {
      path: '/p/packages/web',
      profile: makeProfile('frontend'),
      guard: {
        results: [] as Array<{
          severity: 'error' | 'warning' | 'info';
          status: 'passed' | 'failed' | 'error' | 'warning';
          blocking: boolean;
          file?: string;
        }>,
      },
      inspect: {
        issues: [{ severity: 'error' as const, category: 'quality', file: '/p/packages/web/b.ts' }],
      },
    };

    const agg = scoreProjectModules([backend, frontend]);
    expect(agg.modules).toHaveLength(2);
    const serverCard = agg.modules.find((m) => m.path === '/p/packages/server')!;
    const webCard = agg.modules.find((m) => m.path === '/p/packages/web')!;
    expect(serverCard.type).toBe('backend');
    expect(webCard.type).toBe('frontend');
    // backend 更看重 security，同份安全问题时整体分更低
    expect(serverCard.overall).toBeLessThan(webCard.overall);
    // 聚合 = 等权平均
    expect(agg.overall).toBeCloseTo((serverCard.overall + webCard.overall) / 2, 2);
  });

  it('单模块时退化为该模块自身评分（向后兼容）', () => {
    const only = {
      path: '/p',
      profile: makeProfile('backend'),
      guard: emptyGuard,
      inspect: emptyInspect,
    };
    const agg = scoreProjectModules([only]);
    expect(agg.modules).toHaveLength(1);
    expect(agg.overall).toBeGreaterThanOrEqual(99);
  });

  it('空输入整体分 0', () => {
    expect(scoreProjectModules([]).overall).toBe(0);
  });
});

describe('scoreProjectByModules — 组合分桶 + 逐模块评分（即 recordPipelineScore 调用的入口）', () => {
  it('对准根画像 + 原始 findings 直接给出模块级聚合分，等价于 bucket+score', () => {
    const profile = makeProfile('backend');
    const guard = {
      results: [
        {
          severity: 'error' as const,
          status: 'failed' as const,
          blocking: true,
          file: '/p/packages/server/a.ts',
        },
        {
          severity: 'warning' as const,
          status: 'warning' as const,
          blocking: false,
          file: '/p/packages/web/b.ts',
        },
      ],
    };
    const inspect = {
      issues: [
        {
          severity: 'error' as const,
          category: 'security' as const,
          file: '/p/packages/server/a.ts',
        },
        {
          severity: 'error' as const,
          category: 'security' as const,
          file: '/p/packages/server/a.ts',
        },
        { severity: 'error' as const, category: 'quality' as const, file: '/p/packages/web/b.ts' },
      ],
    };

    const agg = scoreProjectByModules(profile, guard, inspect);
    // 2 子模块 + 1 根级兜底（未命中任何子模块的 findings 归入根级）
    expect(agg.modules).toHaveLength(3);
    const serverCard = agg.modules.find((m) => m.path === '/p/packages/server')!;
    const webCard = agg.modules.find((m) => m.path === '/p/packages/web')!;
    expect(serverCard.type).toBe('backend');
    expect(webCard.type).toBe('frontend');
    // backend 更看重 security，同份安全问题时整体分更低
    expect(serverCard.overall).toBeLessThan(webCard.overall);
    // 聚合 = 各模块等权平均（含根级兜底）
    const mean = agg.modules.reduce((s, m) => s + m.overall, 0) / agg.modules.length;
    expect(agg.overall).toBeCloseTo(mean, 2);
  });

  it('非 monorepo（无 modules）退化为根级单模块评分', () => {
    const profile: ProjectProfile = {
      ...makeProfile('backend'),
      isMonorepo: false,
      modules: undefined,
    };
    const agg = scoreProjectByModules(profile, emptyGuard, emptyInspect);
    expect(agg.modules).toHaveLength(1);
    expect(agg.modules[0].path).toBe('/p');
    expect(agg.overall).toBeGreaterThanOrEqual(99);
  });
});
