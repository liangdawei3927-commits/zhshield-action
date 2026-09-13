import type { ScoringConfig, DimensionDefinition } from './types';

/**
 * 默认维度配置（P2 扩展后 7 维）
 * 质量 20% / 安全性 25% / 依赖 15% / 重构 10% / 性能 5% / 技术债 15% / 门禁哨兵 10%，权重之和 = 1.0
 */
const DEFAULT_DIMENSIONS: DimensionDefinition[] = [
  {
    id: 'quality',
    name: '质量',
    weight: 0.2,
    description: '代码质量、性能、架构、重构、文档与测试',
    penalties: {
      dimension: 'quality',
      maxPenalty: 35,
      perIssuePenalty: 3,
      severityMultipliers: {
        error: 2,
        warning: 1,
        info: 0.3,
      },
    },
    positiveRules: [
      {
        id: 'has-tests',
        name: '有测试覆盖',
        description: '项目有测试文件',
        dimension: 'quality',
        points: 8,
        condition: (ctx) => (ctx.metrics.testCoverage ?? 0) > 0,
      },
      {
        id: 'good-test-coverage',
        name: '测试覆盖率良好',
        description: '测试覆盖率超过60%',
        dimension: 'quality',
        points: 5,
        condition: (ctx) => (ctx.metrics.testCoverage ?? 0) > 60,
      },
    ],
  },
  {
    id: 'refactor',
    name: '重构',
    weight: 0.1,
    description: '代码可维护性与重构实践',
    penalties: {
      dimension: 'refactor',
      maxPenalty: 10,
      perIssuePenalty: 1,
      severityMultipliers: {
        error: 2,
        warning: 1,
        info: 0.5,
      },
    },
    positiveRules: [
      {
        id: 'no-smells',
        name: '无明显代码异味',
        description: '项目无明显代码异味',
        dimension: 'refactor',
        points: 3,
        condition: (ctx) => ctx.findings.length === 0,
      },
    ],
  },
  {
    id: 'performance',
    name: '性能',
    weight: 0.05,
    description: '性能优化与资源效率',
    penalties: {
      dimension: 'performance',
      maxPenalty: 5,
      perIssuePenalty: 1,
      severityMultipliers: {
        critical: 3,
        high: 2,
        medium: 1,
        low: 0.5,
        info: 0.25,
      },
    },
    positiveRules: [
      {
        id: 'no-perf-issues',
        name: '无性能问题',
        description: '项目无明显性能问题',
        dimension: 'performance',
        points: 2,
        condition: (ctx) => ctx.findings.length === 0,
      },
    ],
  },
  {
    id: 'security',
    name: '安全性',
    weight: 0.25,
    description: '代码安全漏洞与密钥管理',
    penalties: {
      dimension: 'security',
      maxPenalty: 30,
      perIssuePenalty: 5,
      severityMultipliers: {
        critical: 3,
        high: 2,
        medium: 1,
        low: 0.5,
      },
    },
    positiveRules: [
      {
        id: 'no-critical-vulns',
        name: '无严重漏洞',
        description: '项目没有严重安全漏洞',
        dimension: 'security',
        points: 10,
        condition: (ctx) => !ctx.findings.some((f) => f.severity === 'critical'),
      },
      {
        id: 'security-tools-configured',
        name: '安全工具已配置',
        description: '项目配置了安全扫描工具',
        dimension: 'security',
        points: 5,
        condition: (ctx) => ctx.metrics.dependencyCount > 0,
      },
    ],
  },
  {
    id: 'dependencies',
    name: '依赖',
    weight: 0.15,
    description: '依赖管理与漏洞',
    penalties: {
      dimension: 'dependencies',
      maxPenalty: 15,
      perIssuePenalty: 2,
      severityMultipliers: {
        high: 2,
        medium: 1,
        low: 0.5,
      },
    },
    positiveRules: [
      {
        id: 'up-to-date-deps',
        name: '依赖已更新',
        description: '没有严重过期的依赖',
        dimension: 'dependencies',
        points: 5,
        condition: (ctx) =>
          !ctx.findings.some((f) => f.category === 'dependency' && f.severity === 'high'),
      },
    ],
  },
  {
    id: 'techdebt',
    name: '技术债',
    weight: 0.15,
    description: '技术债指数（健康分 = 100 − debtIndex）',
    penalties: {
      dimension: 'techdebt',
      maxPenalty: 15,
      perIssuePenalty: 2,
      severityMultipliers: {
        error: 2,
        warning: 1,
        info: 0.5,
      },
    },
    positiveRules: [
      {
        id: 'no-debt-issues',
        name: '无技术债问题',
        description: '没有待处理的技术债问题',
        dimension: 'techdebt',
        points: 5,
        condition: (ctx) => ctx.findings.length === 0,
      },
    ],
  },
  {
    id: 'gate',
    name: '门禁哨兵',
    weight: 0.1,
    description: '门禁检查与哨兵告警',
    penalties: {
      dimension: 'gate',
      maxPenalty: 10,
      perIssuePenalty: 2,
      severityMultipliers: {
        error: 2,
        warning: 1,
      },
    },
    positiveRules: [
      {
        id: 'gate-clean',
        name: '门禁通过',
        description: '没有失败的门禁检查',
        dimension: 'gate',
        points: 5,
        condition: (ctx) =>
          !ctx.findings.some((f) => f.severity === 'error' || f.severity === 'critical'),
      },
    ],
  },
];

export function getDefaultScoringConfig(): ScoringConfig {
  return {
    dimensions: DEFAULT_DIMENSIONS,
    version: '2.2.0',
    lastUpdated: new Date(),
  };
}

export function getDimensionConfig(dimensionId: string): DimensionDefinition | undefined {
  return DEFAULT_DIMENSIONS.find((d) => d.id === dimensionId);
}

export function getDimensionIds(): string[] {
  return DEFAULT_DIMENSIONS.map((d) => d.id);
}