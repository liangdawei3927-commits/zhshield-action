/**
 * 前端性能引擎（engine.ts）
 *
 * 聚合四个静态分析探测器：构建配置 / 包体积 / tree-shaking / chunk 划分。
 * 纯静态分析，绝不执行项目代码（与 P0-2 禁令一致）；零网络；不抛异常。
 */
import * as fs from 'fs';
import { safeJoin } from '@zh/shared';
import type { PerformanceIssue, PerformanceReport, PerformanceConfig } from './types';
import { DEFAULT_CONFIG } from './types';
import { BuildConfigDetectorImpl } from './adapters/build-config-detector';
import { BundleSizeDetectorImpl } from './adapters/bundle-size-detector';
import { TreeShakingDetectorImpl } from './adapters/tree-shaking-detector';

/** 判断给定路径是否为项目根（存在 package.json / 任意构建配置 / 源码目录） */
function isProjectRoot(root: string): boolean {
  return fs.existsSync(safeJoin(root, 'package.json')) || fs.existsSync(safeJoin(root, 'src'));
}

/** 严重度权重（用于排序：critical=0 最高） */
const SEVERITY_WEIGHT: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

export class PerformanceEngine {
  private config: PerformanceConfig;

  constructor(config?: Partial<PerformanceConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** 执行性能检测：聚合四个探测器，统一排序并汇总 */
  scan(projectRoot: string): PerformanceReport {
    const startedAt = Date.now();
    const issues: PerformanceIssue[] = [];
    if (!fs.existsSync(projectRoot) || !isProjectRoot(projectRoot)) {
      return this.buildReport(issues, Date.now() - startedAt);
    }
    this.collectIssues(projectRoot, issues);
    sortIssues(issues);
    return this.buildReport(issues, Date.now() - startedAt);
  }

  /** 聚合四个探测器（内部已各自兜底，此处再兜一层：任何异常不阻断整次扫描） */
  private collectIssues(projectRoot: string, issues: PerformanceIssue[]): void {
    try {
      issues.push(...new BuildConfigDetectorImpl().detect(projectRoot, this.config));
      issues.push(...new BundleSizeDetectorImpl().detect(projectRoot, this.config));
      issues.push(...new TreeShakingDetectorImpl().detect(projectRoot, this.config));
    } catch {
      // 探测器内部已各自兜底，此处再兜一层：任何异常不阻断整次扫描
    }
  }

  private buildReport(issues: PerformanceIssue[], duration: number): PerformanceReport {
    const byCategory: PerformanceReport['summary']['byCategory'] = {};
    for (const issue of issues) {
      byCategory[issue.category] = (byCategory[issue.category] ?? 0) + 1;
    }
    return {
      summary: {
        total: issues.length,
        autoFixable: issues.filter((i) => i.autoFixable).length,
        byCategory,
      },
      issues,
      metadata: {
        duration,
        timestamp: new Date().toISOString(),
      },
    };
  }
}

/** 统一排序：严重度降序，同严重度按类别与文件排序 */
function sortIssues(issues: PerformanceIssue[]): void {
  issues.sort((a, b) => {
    const w = (SEVERITY_WEIGHT[a.severity] ?? 9) - (SEVERITY_WEIGHT[b.severity] ?? 9);
    if (w !== 0) return w;
    if (a.category !== b.category) return a.category.localeCompare(b.category);
    return a.file.localeCompare(b.file);
  });
}
