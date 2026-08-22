import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  findProjectScoringConfigFile,
  loadProjectScoringConfig,
  resolveScoringConfig,
  mergeScoringOverrides,
  validateScoringOverrides,
  ProjectScoringConfigError,
} from '../project-scoring-config';
import { getDefaultScoringConfig } from '../scoring-config';
import { DimensionMapper } from '../dimension-mapper';
import { buildHealthDimensions } from '../pipeline-score';
import { ScoringEngine } from '../scoring-engine';

/** 创建带可选文件的临时项目目录，测试结束后统一清理 */
const tempRoots: string[] = [];

function makeProject(files: Record<string, string> = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zh-scoring-'));
  tempRoots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
  }
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempRoots.length > 0) {
    const root = tempRoots.pop()!;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** 合法局部覆盖：security 加权 + quality 减重（保持权重和为 1），并覆盖扣分/加分参数 */
const VALID_OVERRIDE_YML = `# 项目级评分覆盖
dimensions:
  security:
    weight: 0.40
    penalties:
      maxPenalty: 40
      severityMultipliers:
        critical: 4
    positiveRules:
      no-critical-vulns:
        points: 15
  quality:
    weight: 0.20
`;

function findDim(config: ReturnType<typeof loadProjectScoringConfig>, id: string) {
  const dim = config.dimensions.find((d) => d.id === id);
  if (!dim) throw new Error(`dimension ${id} not found`);
  return dim;
}

describe('loadProjectScoringConfig — 无覆盖文件', () => {
  it('空项目返回纯默认配置（行为不变）', () => {
    const root = makeProject();

    expect(findProjectScoringConfigFile(root)).toBeNull();

    const config = loadProjectScoringConfig(root);
    const defaults = getDefaultScoringConfig();

    expect(config.dimensions.map((d) => d.id)).toEqual(defaults.dimensions.map((d) => d.id));
    expect(config.dimensions.map((d) => d.weight)).toEqual(defaults.dimensions.map((d) => d.weight));
    expect(config.dimensions.map((d) => d.penalties.maxPenalty))
      .toEqual(defaults.dimensions.map((d) => d.penalties.maxPenalty));
    // 权重归一化仍然成立
    const sum = config.dimensions.reduce((s, d) => s + d.weight, 0);
    expect(sum).toBeCloseTo(1, 3);
  });

  it('resolveScoringConfig 在无覆盖时等价于默认配置', () => {
    const root = makeProject();
    const config = resolveScoringConfig(root);
    expect(config.dimensions.map((d) => d.weight)).toEqual(getDefaultScoringConfig().dimensions.map((d) => d.weight));
  });
});

describe('loadProjectScoringConfig — 合法局部覆盖', () => {
  it('deep merge：project > defaults，未指定字段继承默认值', () => {
    const root = makeProject({ '.zhshield/scoring.yml': VALID_OVERRIDE_YML });

    expect(findProjectScoringConfigFile(root)).not.toBeNull();

    const config = loadProjectScoringConfig(root);

    // 被覆盖的权重生效
    expect(findDim(config, 'security').weight).toBeCloseTo(0.4, 10);
    expect(findDim(config, 'quality').weight).toBeCloseTo(0.2, 10);
    // 未覆盖的维度保持默认
    expect(findDim(config, 'architecture').weight).toBeCloseTo(0.2, 10);
    expect(findDim(config, 'dependencies').weight).toBeCloseTo(0.15, 10);
    expect(findDim(config, 'documentation').weight).toBeCloseTo(0.05, 10);
    // 权重归一化仍然成立
    const sum = config.dimensions.reduce((s, d) => s + d.weight, 0);
    expect(sum).toBeCloseTo(1, 3);

    // penalties 字段级合并：maxPenalty 覆盖，perIssuePenalty 继承
    const security = findDim(config, 'security');
    expect(security.penalties.maxPenalty).toBe(40);
    expect(security.penalties.perIssuePenalty).toBe(5);

    // severityMultipliers 按 key 合并：critical 覆盖，其余保留默认
    expect(security.penalties.severityMultipliers.critical).toBe(4);
    expect(security.penalties.severityMultipliers.high).toBe(2);
    expect(security.penalties.severityMultipliers.medium).toBe(1);
    expect(security.penalties.severityMultipliers.low).toBe(0.5);

    // positiveRules 按规则 id 匹配：points 覆盖，condition/name/description 继承
    const rule = security.positiveRules.find((r) => r.id === 'no-critical-vulns')!;
    expect(rule.points).toBe(15);
    expect(rule.name).toBe('无严重漏洞');
    expect(typeof rule.condition).toBe('function');
    // 未提及的规则不受影响
    expect(security.positiveRules.find((r) => r.id === 'security-tools-configured')!.points).toBe(5);
  });

  it('支持 .yaml 扩展名回退探测', () => {
    const root = makeProject({
      '.zhshield/scoring.yaml': [
        'dimensions:',
        '  dependencies:',
        '    weight: 0.10',
        '  documentation:',
        '    weight: 0.10',
        '',
      ].join('\n'),
    });

    const config = loadProjectScoringConfig(root);
    expect(findDim(config, 'dependencies').weight).toBeCloseTo(0.1, 10);
    expect(findDim(config, 'documentation').weight).toBeCloseTo(0.1, 10);
    expect(findDim(config, 'security').weight).toBeCloseTo(0.35, 10);
  });

  it('DimensionMapper / buildHealthDimensions 透明消费项目覆盖权重', () => {
    const root = makeProject({ '.zhshield/scoring.yml': VALID_OVERRIDE_YML });

    const mapper = new DimensionMapper(undefined, root);
    expect(mapper.getWeightMap().security).toBeCloseTo(0.4, 10);
    expect(mapper.getWeightMap().quality).toBeCloseTo(0.2, 10);
    expect(mapper.validateWeights().valid).toBe(true);

    const dims = buildHealthDimensions({ results: [] }, { issues: [] }, root);
    expect(dims.find((d) => d.name === 'security')?.weight).toBeCloseTo(0.4, 10);
    expect(dims.find((d) => d.name === 'documentation')?.weight).toBeCloseTo(0.05, 10);
  });

  it('显式传入 config 时优先级高于项目覆盖文件', () => {
    const root = makeProject({ '.zhshield/scoring.yml': VALID_OVERRIDE_YML });
    const explicit = getDefaultScoringConfig();

    const mapper = new DimensionMapper(explicit, root);
    expect(mapper.getWeightMap().security).toBeCloseTo(0.35, 10);
  });

  it('ContextScoringEngine 默认构造经 process.cwd() 透明加载项目覆盖', () => {
    const root = makeProject({ '.zhshield/scoring.yml': VALID_OVERRIDE_YML });

    const context = {
      findings: [{ severity: 'critical', category: 'security' }],
      metrics: { dependencyCount: 0, circularDependencies: 0, totalFiles: 0 },
    };

    // 基线引擎必须先于 cwd stub 构造，否则它也会读到项目覆盖
    const defaultOverall = new ScoringEngine().score(context).overall;
    expect(defaultOverall).toBeCloseTo(94.75, 2);

    vi.spyOn(process, 'cwd').mockReturnValue(root);

    // 项目覆盖后：security 扣分 5×4=20 → 维度分 80、权重 0.4；overall = 80×0.4 + 100×0.6 = 92
    const result = new ScoringEngine().score(context);
    expect(result.overall).toBe(92);
    expect(result.details.find((d) => d.dimension === 'security')?.weight).toBeCloseTo(0.4, 10);
    expect(result.details.find((d) => d.dimension === 'security')?.negative).toBe(20);
  });
});

describe('非法覆盖 — fail-fast 策略', () => {
  it('weight 类型错误（字符串）→ 明确报错', () => {
    const root = makeProject({
      '.zhshield/scoring.yml': ['dimensions:', '  security:', '    weight: high', ''].join('\n'),
    });

    expect(() => loadProjectScoringConfig(root)).toThrow(ProjectScoringConfigError);
    expect(() => loadProjectScoringConfig(root)).toThrow(/weight 必须是有限数字/);
  });

  it('未知维度 → 报错并列出可用维度', () => {
    const root = makeProject({
      '.zhshield/scoring.yml': ['dimensions:', '  seo:', '    weight: 0.1', ''].join('\n'),
    });

    expect(() => loadProjectScoringConfig(root)).toThrow(/未知维度 "seo"/);
    expect(() => loadProjectScoringConfig(root)).toThrow(/security/);
  });

  it('权重和 ≠ 1 → 报错并给出当前总和', () => {
    const root = makeProject({
      '.zhshield/scoring.yml': ['dimensions:', '  security:', '    weight: 0.5', ''].join('\n'),
    });

    // 0.5 + 0.25 + 0.20 + 0.15 + 0.05 = 1.15
    expect(() => loadProjectScoringConfig(root)).toThrow(ProjectScoringConfigError);
    expect(() => loadProjectScoringConfig(root)).toThrow(/权重之和必须为 1/);
    expect(() => loadProjectScoringConfig(root)).toThrow(/1\.15/);
  });

  it('未知加分规则 id → 报错', () => {
    const root = makeProject({
      '.zhshield/scoring.yml': [
        'dimensions:',
        '  security:',
        '    positiveRules:',
        '      made-up-rule:',
        '        points: 5',
        '',
      ].join('\n'),
    });

    expect(() => loadProjectScoringConfig(root)).toThrow(/未知加分规则 "made-up-rule"/);
  });

  it('未知顶层字段 → 报错（防止拼写错误静默失效）', () => {
    const root = makeProject({
      '.zhshield/scoring.yml': ['weights:', '  security: 0.9', ''].join('\n'),
    });

    expect(() => loadProjectScoringConfig(root)).toThrow(/未知字段 "weights"/);
  });

  it('负数 perIssuePenalty → 报错', () => {
    const root = makeProject({
      '.zhshield/scoring.yml': [
        'dimensions:',
        '  quality:',
        '    penalties:',
        '      perIssuePenalty: -3',
        '',
      ].join('\n'),
    });

    expect(() => loadProjectScoringConfig(root)).toThrow(/不能小于 0/);
  });

  it('validateScoringOverrides 拒绝非映射顶层输入', () => {
    expect(() => validateScoringOverrides(null)).toThrow(ProjectScoringConfigError);
    expect(() => validateScoringOverrides([1, 2])).toThrow(/顶层必须是映射/);
    expect(() => validateScoringOverrides('dimensions')).toThrow(/顶层必须是映射/);
  });
});

describe('mergeScoringOverrides — 纯函数语义', () => {
  it('不修改默认配置（深拷贝），重复调用结果一致', () => {
    const overrides = validateScoringOverrides({
      dimensions: {
        security: { weight: 0.4, penalties: { severityMultipliers: { critical: 9 } } },
        quality: { weight: 0.2 },
      },
    });

    const merged = mergeScoringOverrides(overrides);
    const fresh = getDefaultScoringConfig();

    // 默认配置未被污染
    expect(findDim(fresh, 'security').penalties.severityMultipliers.critical).toBe(3);
    expect(findDim(fresh, 'security').weight).toBeCloseTo(0.35, 10);

    // 返回的是全新对象
    expect(merged.dimensions).not.toBe(fresh.dimensions);
    expect(merged.dimensions[0]).not.toBe(fresh.dimensions[0]);

    // 合并结果正确
    expect(findDim(merged, 'security').penalties.severityMultipliers.critical).toBe(9);
    expect(findDim(merged, 'security').penalties.severityMultipliers.high).toBe(2);
    expect(findDim(merged, 'quality').weight).toBeCloseTo(0.2, 10);
  });

  it('程序化构造的未知维度在合并阶段同样被拒绝（纵深防御）', () => {
    expect(() => mergeScoringOverrides({ dimensions: { 'no-such-dim': {} } })).toThrow(
      ProjectScoringConfigError,
    );
  });
});
