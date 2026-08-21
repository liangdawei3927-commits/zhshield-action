import type { ScoringConfig, DimensionDefinition } from './types';

/**
 * 默认维度配置
 * 5 个维度，权重之和 = 1.0
 */
const DEFAULT_DIMENSIONS: DimensionDefinition[] = [
  {
    id: 'security',
    name: '安全性',
    weight: 0.35,
    description: '代码安全漏洞和安全实践',
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
        condition: (ctx) => ctx.findings.filter(f => f.severity === 'critical').length === 0,
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
    id: 'quality',
    name: '代码质量',
    weight: 0.25,
    description: '代码质量、复杂度和可维护性',
    penalties: {
      dimension: 'quality',
      maxPenalty: 25,
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
    id: 'architecture',
    name: '架构',
    weight: 0.20,
    description: '项目架构和依赖管理',
    penalties: {
      dimension: 'architecture',
      maxPenalty: 20,
      perIssuePenalty: 4,
      severityMultipliers: {
        error: 2,
        warning: 1,
        info: 0.5,
      },
    },
    positiveRules: [
      {
        id: 'no-circular-deps',
        name: '无循环依赖',
        description: '项目没有循环依赖',
        dimension: 'architecture',
        points: 10,
        condition: (ctx) => ctx.metrics.circularDependencies === 0,
      },
      {
        id: 'modular-structure',
        name: '模块化结构',
        description: '项目有良好的模块划分',
        dimension: 'architecture',
        points: 5,
        condition: (ctx) => ctx.metrics.totalFiles > 10,
      },
    ],
  },
  {
    id: 'dependencies',
    name: '依赖',
    weight: 0.15,
    description: '依赖管理和更新',
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
        condition: (ctx) => ctx.findings.filter(f => f.category === 'dependency' && f.severity === 'high').length === 0,
      },
    ],
  },
  {
    id: 'documentation',
    name: '文档',
    weight: 0.05,
    description: '文档覆盖率和注释密度',
    penalties: {
      dimension: 'documentation',
      maxPenalty: 5,
      perIssuePenalty: 1,
      severityMultipliers: {
        warning: 1,
        info: 0.3,
      },
    },
    positiveRules: [
      {
        id: 'has-readme',
        name: '有README',
        description: '项目有README文件',
        dimension: 'documentation',
        points: 3,
        condition: (ctx) => ctx.metrics.documentationCoverage !== undefined && ctx.metrics.documentationCoverage > 0,
      },
    ],
  },
];

export function getDefaultScoringConfig(): ScoringConfig {
  return {
    dimensions: DEFAULT_DIMENSIONS,
    version: '2.0.0',
    lastUpdated: new Date(),
  };
}

export function getDimensionConfig(dimensionId: string): DimensionDefinition | undefined {
  return DEFAULT_DIMENSIONS.find(d => d.id === dimensionId);
}

export function getDimensionIds(): string[] {
  return DEFAULT_DIMENSIONS.map(d => d.id);
}
