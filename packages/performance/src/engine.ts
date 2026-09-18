/**
 * 前端性能引擎（engine.ts）
 *
 * 聚合四个静态分析探测器：构建配置 / 包体积 / tree-shaking+chunk 划分 / 复杂度。
 * 纯静态分析，绝不执行项目代码（与 P0-2 禁令一致）；零网络；不抛异常。
 */
import * as fs from 'fs';
import { safeJoin } from '@zh/shared';
import type { PerformanceIssue, PerformanceReport, PerformanceConfig } from './types';
import { DEFAULT_CONFIG } from './types';
import { resolveSourceRoots } from './source-roots';
import { BuildConfigDetectorImpl } from './adapters/build-config-detector';
import { BundleSizeDetectorImpl } from './adapters/bundle-size-detector';
import { TreeShakingDetectorImpl } from './adapters/tree-shaking-detector';
import { ComplexityDetectorImpl } from './adapters/complexity-detector';

/** 判断给定路径是否为项目根（存在 package.json / 任意源码根 / 已解析出源码目录） */
function isProjectRoot(root: string): boolean {
  return fs.existsSync(safeJoin(root, 'package.json')) || resolveSourceRoots(root).length > 0;
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

  /** 执行性能检测：聚合五个探测器，统一排序并汇总 */
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
      this.reportMissingSourceRoot(projectRoot, issues);
      issues.push(...new BuildConfigDetectorImpl().detect(projectRoot, this.config));
      issues.push(...new BundleSizeDetectorImpl().detect(projectRoot, this.config));
      issues.push(...new TreeShakingDetectorImpl().detect(projectRoot, this.config));
      issues.push(...new ComplexityDetectorImpl().detect(projectRoot, this.config));
    } catch {
      // 探测器内部已各自兜底，此处再兜一层：任何异常不阻断整次扫描
    }
  }

  /**
   * 源码根缺失时显式告知（诚实性约束）。
   *
   * 四处探测器中，复杂度与 tree-shaking 都依赖源码文件；解析不出源码根时它们
   * 产出 0 条，面板会显示「0 问题」—— 那是「没查」而不是「没问题」。
   * 这里补一条 info 级说明，让用户看见覆盖面缺口。
   */
  private reportMissingSourceRoot(projectRoot: string, issues: PerformanceIssue[]): void {
    if (resolveSourceRoots(projectRoot).length > 0) return;
    if (!fs.existsSync(safeJoin(projectRoot, 'package.json'))) return;
    issues.push({
      id: 'coverage-no-source-root',
      ruleId: 'coverage.no-source-root',
      category: 'complexity',
      severity: 'info',
      file: '',
      message:
        '未发现源码根目录（src/ · app/ · packages/*/src · apps/*/src）— 复杂度与 tree-shaking 检测本次未执行，0 条不等于无问题',
      suggestion: '请核对项目结构；若源码位于非约定目录，请在项目根建立 src/ 软链或调整目录约定',
      autoFixable: false,
    });
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
