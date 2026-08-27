import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { buildHealthDimensions } from '../pipeline-score';
import { ScoringEngine } from '../engine';
import { resolveProfileScoring } from '../profile-scoring-resolver';
import { profileSync } from '@zh/fingerprint';
import type { ScoringProjectProfile, ProjectType } from '@zh/fingerprint';

/**
 * 评分校准夹具（Task C：真实跑分校准）
 *
 * 目标：把"各类型权重是否合理"从口头判断变成可重复、可验证、可回归的校准。
 * - 用真实 profiler（@zh/fingerprint profileSync）扫描实际工作区，得到真实画像；
 * - 用一组标准化 findings 跑通完整评分管线，覆盖全部 7 种非 unknown 项目类型；
 * - 锁定校准不变量：权重和=1、不适用维度置 0、增量行和为 0、以及"前端安全降权/质量升权"
 *   带来的可预期区分度；并打印校准表供人工核对。
 *
 * 注：当前 TYPE_WEIGHT_DELTAS 为基于产品判断的手工设定，且每一行增量和=0（保持健康），
 * 本夹具不擅自改动数值——它提供"真实跑分"机制与回归锁，后续基于真实运行数据微调时，
 * 此处断言会捕获回退。
 */

const TYPES: ProjectType[] = ['backend', 'frontend', 'app', 'mini-program', 'desktop', 'library', 'cli'];

/** 构造贴近真实技术栈的画像（仅 type/framework 影响评分适配，其余字段填最小合理值） */
function makeRealisticProfile(type: ProjectType): ScoringProjectProfile {
  const frameworkByType: Record<ProjectType, string> = {
    backend: 'nestjs',
    frontend: 'react',
    app: 'react-native',
    'mini-program': 'wechat-miniprogram',
    desktop: 'electron',
    library: 'none',
    cli: 'none',
    monorepo: 'none',
    unknown: 'none',
  };
  const runtimeByType: Record<ProjectType, string> = {
    backend: 'node',
    frontend: 'browser',
    app: 'react-native',
    'mini-program': 'wechat',
    desktop: 'electron',
    library: 'node',
    cli: 'node',
    monorepo: 'node',
    unknown: 'unknown',
  };
  return {
    version: '1.0.0',
    projectRoot: '/cal',
    language: 'typescript',
    secondaryLanguages: [],
    framework: frameworkByType[type],
    type,
    runtime: runtimeByType[type],
    packageManager: 'pnpm',
    isMonorepo: false,
    detectedFiles: [],
    confidence: 0.8,
    detectedAt: new Date(),
    signals: [],
  };
}

const emptyGuard = { results: [] as Array<{ severity: 'error' | 'warning' | 'info'; status: 'passed' | 'failed' | 'error' | 'warning'; blocking: boolean }> };
const emptyInspect = { issues: [] as Array<{ severity: 'error' | 'warning' | 'info'; category: string }> };

function overallOf(
  profile: ScoringProjectProfile,
  guard = emptyGuard,
  inspect = emptyInspect,
): number {
  const dims = buildHealthDimensions(guard, inspect, undefined, profile);
  return new ScoringEngine().calculate(profile.type, dims).overall;
}

function weightMapOf(profile: ScoringProjectProfile): Record<string, number> {
  const dims = buildHealthDimensions(emptyGuard, emptyInspect, undefined, profile);
  return Object.fromEntries(dims.map((d) => [d.name, d.weight]));
}

/** 向上查找 pnpm-workspace.yaml 定位仓库根（真实跑分目标） */
function findRepoRoot(start: string): string {
  let dir = start;
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = path.dirname(dir);
  }
  return start;
}

describe('评分校准 — 权重不变量（Task C）', () => {
  it('每种类型的维度权重和恒为 1', () => {
    for (const t of TYPES) {
      const wm = weightMapOf(makeRealisticProfile(t));
      const sum = Object.values(wm).reduce((a, b) => a + b, 0);
      expect(Math.abs(sum - 1)).toBeLessThan(0.02);
    }
  });

  it('mini-program / cli 剔除 architecture 维度（权重置 0）', () => {
    expect(weightMapOf(makeRealisticProfile('mini-program')).architecture).toBe(0);
    expect(weightMapOf(makeRealisticProfile('cli')).architecture).toBe(0);
  });

  it('其余类型保留 architecture 维度', () => {
    for (const t of ['backend', 'frontend', 'app', 'desktop', 'library'] as const) {
      expect(weightMapOf(makeRealisticProfile(t)).architecture).toBeGreaterThan(0);
    }
  });

  it('每种类型的权重增量行和为 0（防止权重漂移）', () => {
    for (const t of TYPES) {
      const o = resolveProfileScoring(makeRealisticProfile(t));
      if (!o.weightDeltas) continue;
      const sum = Object.values(o.weightDeltas).reduce((a, b) => a + (b ?? 0), 0);
      expect(Math.abs(sum)).toBeLessThan(1e-9);
    }
  });
});

describe('评分校准 — 类型区分度（Task C）', () => {
  it('同一安全失败：frontend 扣分少于 backend（前端安全降权）', () => {
    const securityGuard = {
      results: [{ severity: 'error' as const, status: 'failed' as const, blocking: true }],
    };
    const frontend = overallOf(makeRealisticProfile('frontend'), securityGuard);
    const backend = overallOf(makeRealisticProfile('backend'), securityGuard);
    expect(frontend).toBeGreaterThan(backend);
  });

  it('同一质量错误：backend 扣分少于 frontend（前端质量升权）', () => {
    const qualityInspect = {
      issues: [{ severity: 'error' as const, category: 'quality' }],
    };
    const backend = overallOf(makeRealisticProfile('backend'), emptyGuard, qualityInspect);
    const frontend = overallOf(makeRealisticProfile('frontend'), emptyGuard, qualityInspect);
    expect(backend).toBeGreaterThan(frontend);
  });

  it('架构问题对 mini-program 无影响（architecture 已禁用）', () => {
    const archInspect = {
      issues: [{ severity: 'error' as const, category: 'architecture' }],
    };
    const withIssue = overallOf(makeRealisticProfile('mini-program'), emptyGuard, archInspect);
    const without = overallOf(makeRealisticProfile('mini-program'));
    expect(withIssue).toBeCloseTo(without, 5);
  });
});

describe('评分校准 — 真实跑分（Task C）', () => {
  it('用真实 profiler 扫描实际工作区并跑分，结果合法且权重和=1', () => {
    const repoRoot = findRepoRoot(__dirname);
    const result = profileSync(repoRoot);
    const real = result.profile;
    expect(real).toBeTruthy();
    expect(real.type).toBeTruthy();

    const dims = buildHealthDimensions(emptyGuard, emptyInspect, repoRoot, real);
    const score = new ScoringEngine().calculate(repoRoot, dims);
    expect(score.overall).toBeGreaterThanOrEqual(0);
    expect(score.overall).toBeLessThanOrEqual(100);

    const sum = dims.reduce((s, d) => s + d.weight, 0);
    expect(Math.abs(sum - 1)).toBeLessThan(0.02);
  });

  it('校准表：标准化 findings 下各类型总分（人工核对用）', () => {
    const mixedGuard = {
      results: [
        { severity: 'error' as const, status: 'failed' as const, blocking: true },
        { severity: 'warning' as const, status: 'warning' as const, blocking: false },
      ],
    };
    const mixedInspect = {
      issues: [
        { severity: 'error' as const, category: 'security' },
        { severity: 'warning' as const, category: 'quality' },
        { severity: 'error' as const, category: 'architecture' },
        { severity: 'warning' as const, category: 'dependency' },
      ],
    };

    const rows = TYPES.map((t) => {
      const profile = makeRealisticProfile(t);
      const dims = buildHealthDimensions(mixedGuard, mixedInspect, undefined, profile);
      const score = new ScoringEngine().calculate(t, dims);
      const wm = weightMapOf(profile);
      return {
        type: t,
        overall: score.overall,
        grade: score.grade,
        securityW: wm.security,
        qualityW: wm.quality,
        archW: wm.architecture,
        depsW: wm.dependencies,
        docW: wm.documentation,
      };
    });

     
    console.log('\n=== 评分校准表（标准化 findings：1 安全失败 + 1 警告；4 条 inspect）===');
     
    console.table(rows);

    for (const r of rows) {
      expect(r.overall).toBeGreaterThanOrEqual(0);
      expect(r.overall).toBeLessThanOrEqual(100);
    }
  });
});
