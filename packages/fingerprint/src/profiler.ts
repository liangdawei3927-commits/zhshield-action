// Profiler 聚合层（架构文档 §6.4）：Signal[] → ProjectProfile
// 两阶段判定：① 语言/框架/环境聚合 + 置信度加权 → ② 形态语义判定（消费语言结果 + 交叉验证）
// 职责拆分：语言/框架/环境/形态/目标构建/修正合并 各自独立类，Profiler 仅编排委托。

import type {
  Signal,
  LanguageId,
  MatchResult,
  ProjectProfile,
  UserOverrides,
} from './types';
import type { Detector } from './detector';
import { LanguageAggregator } from './profiler-language';
import { FrameworkAggregator } from './profiler-framework';
import { EnvironmentAggregator } from './profiler-environment';
import { FormDeterminer } from './profiler-form';
import type { FormCandidate } from './profiler-form';
import { TargetBuilder } from './profiler-target';
import { OverrideMerger } from './profiler-overrides';

// ─── Profiler 类 ───

export class Profiler {
  private readonly detectors: readonly Detector[];
  private readonly languageAggregator = new LanguageAggregator();
  private readonly frameworkAggregator = new FrameworkAggregator();
  private readonly environmentAggregator = new EnvironmentAggregator();
  private readonly formDeterminer = new FormDeterminer();
  private readonly targetBuilder = new TargetBuilder();
  private readonly overrideMerger = new OverrideMerger();

  constructor(detectors: readonly Detector[]) {
    this.detectors = detectors;
  }

  /**
   * 执行项目画像探测（架构文档 §6.4 三阶段流水线）
   * @param projectPath 项目根路径
   * @param overrides 人工修正记录（可选）
   * @returns ProjectProfile
   */
  async profile(
    projectPath: string,
    overrides?: UserOverrides,
  ): Promise<ProjectProfile> {
    const allSignals = await this.collectSignals(projectPath);
    const { languageResult, frameworkResults, environmentResults, packageManagerResult, formResults } = this.aggregateAllFields(allSignals);
    const target = this.targetBuilder.build(projectPath, languageResult, frameworkResults, formResults, packageManagerResult);
    const architecture = this.targetBuilder.determineArchitecture(allSignals);
    const dependencies = this.targetBuilder.extractDependencySummary(allSignals);
    const mergedOverrides = this.overrideMerger.merge(overrides, target);
    return {
      schemaVersion: 1,
      architecture,
      targets: [target],
      environments: environmentResults,
      dependencies,
      detectedAt: new Date().toISOString(),
      stale: false,
      signals: allSignals,
      overrides: mergedOverrides,
    };
  }

  /** 聚合全部判定维度（语言/框架/环境/包管理器/形态） */
  private aggregateAllFields(signals: readonly Signal[]): {
    languageResult: MatchResult<LanguageId>;
    frameworkResults: readonly MatchResult<string>[];
    environmentResults: readonly MatchResult<string>[];
    packageManagerResult: MatchResult<string> | undefined;
    formResults: readonly FormCandidate[];
  } {
    const languageResult = this.languageAggregator.aggregate(signals);
    const frameworkResults = this.frameworkAggregator.aggregate(signals, languageResult.value);
    const { environments, packageManager } = this.environmentAggregator.aggregate(signals);
    const formResults = this.formDeterminer.determine(signals, languageResult.value);
    return { languageResult, frameworkResults, environmentResults: environments, packageManagerResult: packageManager, formResults };
  }

  // ─── 信号采集 ───

  /** 并行运行所有 Detector 收集信号 */
  private async collectSignals(projectPath: string): Promise<readonly Signal[]> {
    const results = await Promise.all(
      this.detectors.map((detector) => detector.detect(projectPath)),
    );
    return results.flat();
  }
}

// ─── 导出工厂函数 ───

/**
 * 创建 Profiler 实例
 * @param detectors 探测器列表（默认使用所有内置探测器）
 */
export function createProfiler(detectors?: readonly Detector[]): Profiler {
  // 延迟导入避免循环依赖
  const defaultDetectors = detectors ?? [];
  return new Profiler(defaultDetectors);
}