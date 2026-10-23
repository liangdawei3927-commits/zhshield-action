import { describe, expect, it, vi } from 'vitest';
import {
  bucketFindingsByModule,
  resolveModuleId,
  scoreProjectModules,
  scoreProjectByModules,
} from '../module-score';
import { ScoringEngine } from '../engine';
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
    // 两份完全相同的安全问题报告：backend 更看重 security（权重更高），整体分更低
    const backend = {
      path: '/p/packages/server',
      id: '/p/packages/server',
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
      id: '/p/packages/web',
      profile: makeProfile('frontend'),
      guard: {
        results: [
          {
            severity: 'error' as const,
            status: 'failed' as const,
            blocking: true,
            file: '/p/packages/web/b.ts',
          },
        ],
      },
      inspect: {
        issues: [
          { severity: 'error' as const, category: 'security', file: '/p/packages/web/b.ts' },
          { severity: 'error' as const, category: 'security', file: '/p/packages/web/b.ts' },
        ],
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
    // 聚合 = 等权平均（overall 四舍五入到 2 位，均值可能差 0.005，用 1 位精度断言）
    expect(agg.overall).toBeCloseTo((serverCard.overall + webCard.overall) / 2, 1);
  });

  it('单模块时退化为该模块自身评分（向后兼容）', () => {
    const only = {
      path: '/p',
      id: '/p',
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
          severity: 'error' as const,
          status: 'failed' as const,
          blocking: true,
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
        {
          severity: 'error' as const,
          category: 'security' as const,
          file: '/p/packages/web/b.ts',
        },
        {
          severity: 'error' as const,
          category: 'security' as const,
          file: '/p/packages/web/b.ts',
        },
      ],
    };

    const agg = scoreProjectByModules(profile, guard, inspect);
    // 2 子模块 + 1 根级兜底（未命中任何子模块的 findings 归入根级）
    expect(agg.modules).toHaveLength(3);
    const serverCard = agg.modules.find((m) => m.path === '/p/packages/server')!;
    const webCard = agg.modules.find((m) => m.path === '/p/packages/web')!;
    expect(serverCard.type).toBe('backend');
    expect(webCard.type).toBe('frontend');
    // 同份安全问题：backend 更看重 security，整体分更低
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

// ─── 身份键（id）：模块评分落库不得用相对路径 ────────────────────────────
// 背景：`scores.project_id` 曾直接取画像给的相对路径（packages/ui），
// 任意两个 monorepo 只要有同名子包就写进同一行、历史曲线互相污染。
// 修复：path（相对，分桶匹配用）与 id（绝对，落库用）显式分开。

/** 真实画像形态：modules 是相对项目根的路径（与 findings.file 同前缀） */
function makeRelativeProfile(root: string): ScoringProjectProfile {
  return {
    ...makeProfile('backend'),
    projectRoot: root,
    modules: [
      { path: 'packages/ui', language: 'typescript', framework: 'react', type: 'frontend' },
      { path: 'packages/api-sdk', language: 'typescript', framework: 'unknown', type: 'library' },
    ],
  };
}

describe('resolveModuleId — 相对路径解析为绝对身份键', () => {
  it('相对路径按项目根拼接', () => {
    expect(resolveModuleId('/a/b', 'packages/ui')).toBe('/a/b/packages/ui');
  });

  it('已是绝对路径时原样保留（不重复拼接）', () => {
    expect(resolveModuleId('/a/b', '/abs/x')).toBe('/abs/x');
  });

  it('空模块路径退化为项目根本身', () => {
    expect(resolveModuleId('/a/b', '')).toBe('/a/b');
  });
});

describe('模块身份键 — 同名子包跨项目不得撞车', () => {
  it('两个项目根下的同名模块解析出不同的 id', () => {
    const a = resolveModuleId('/proj/tianyin', 'packages/ui');
    const b = resolveModuleId('/proj/other', 'packages/ui');
    expect(a).not.toBe(b);
    expect(a).toBe('/proj/tianyin/packages/ui');
    expect(b).toBe('/proj/other/packages/ui');
  });

  it('bucketFindingsByModule 产出绝对 id，同时保留相对 path 供分桶匹配', () => {
    const bucketed = bucketFindingsByModule(makeRelativeProfile('/proj/a'), emptyGuard, emptyInspect);
    const ui = bucketed.find((m) => m.path === 'packages/ui')!;
    expect(ui).toBeDefined();
    expect(ui.path).toBe('packages/ui');
    expect(ui.id).toBe('/proj/a/packages/ui');
    // 分桶仍按相对前缀匹配（findings.file 也是相对）
    const withFiles = bucketFindingsByModule(
      makeRelativeProfile('/proj/a'),
      { results: [] },
      {
        issues: [
          { severity: 'error' as const, category: 'quality', file: 'packages/ui/src/x.ts' },
        ],
      },
    );
    expect(withFiles.find((m) => m.path === 'packages/ui')!.inspect.issues).toHaveLength(1);
  });

  it('根级兜底卡的 id 等于项目根绝对路径', () => {
    const bucketed = bucketFindingsByModule(makeRelativeProfile('/proj/a'), emptyGuard, emptyInspect);
    expect(bucketed.at(-1)!.id).toBe('/proj/a');
  });

  it('落库键（calculate 的首参）必须是绝对路径', () => {
    const spy = vi.spyOn(ScoringEngine.prototype, 'calculate');
    try {
      scoreProjectModules(bucketFindingsByModule(makeRelativeProfile('/proj/a'), emptyGuard, emptyInspect));
      const ids = spy.mock.calls.map((c) => c[0]);
      expect(ids).toHaveLength(3); // 2 子模块 + 根兜底
      for (const id of ids) {
        expect(id.startsWith('/')).toBe(true);
      }
      expect(ids).toContain('/proj/a/packages/ui');
      expect(ids).not.toContain('packages/ui');
    } finally {
      spy.mockRestore();
    }
  });

  it('模块卡同时暴露 path 与 id，两者语义不同', () => {
    const agg = scoreProjectModules(
      bucketFindingsByModule(makeRelativeProfile('/proj/a'), emptyGuard, emptyInspect),
    );
    const ui = agg.modules.find((m) => m.path === 'packages/ui')!;
    expect(ui.path).toBe('packages/ui');
    expect(ui.id).toBe('/proj/a/packages/ui');
  });
});
