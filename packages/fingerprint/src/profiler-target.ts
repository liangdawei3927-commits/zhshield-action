// 目标画像构建器：TargetProfile / 架构形态 / 依赖摘要（Profiler 拆分重构产物）

import type {
  Signal,
  LanguageId,
  ArchitectureForm,
  MatchResult,
  TargetProfile,
  DependencySummary,
} from './types';
import { calculateFormConfidence } from './profiler-form';
import type { FormCandidate } from './profiler-form';

/** TargetBuilder.build 参数对象 */
export interface BuildParams {
  /** 项目根路径 */
  readonly projectPath: string;
  /** 语言判定结果 */
  readonly language: MatchResult<LanguageId>;
  /** 框架判定结果列表 */
  readonly frameworks: readonly MatchResult<string>[];
  /** 形态候选列表 */
  readonly forms: readonly FormCandidate[];
  /** 包管理器判定结果（可能缺失） */
  readonly packageManager: MatchResult<string> | undefined;
}

/** 目标画像构建器 */
export class TargetBuilder {
  /** 构建 TargetProfile */
  build(params: BuildParams): TargetProfile {
    const { projectPath, language, frameworks, forms, packageManager } = params;

    // 选择最高置信度的形态
    const primaryForm = forms.length > 0 ? forms[0] : undefined;

    // 构建 routeKey：${language}:${framework}:${form}
    const routeKey = [
      language.value,
      frameworks.length > 0 ? frameworks[0].value : '*',
      primaryForm?.form ?? '*',
    ].join(':');

    return {
      id: 'default',
      path: projectPath,
      language,
      frameworks,
      productForm:
        primaryForm !== undefined
          ? {
              value: primaryForm.form,
              confidence: calculateFormConfidence(primaryForm.score, primaryForm.isDecisive),
              signals: primaryForm.signals,
            }
          : undefined,
      packageManager,
      routeKey,
    };
  }

  /** 架构形态判定（简化版） */
  determineArchitecture(signals: readonly Signal[]): MatchResult<ArchitectureForm> {
    // 检查 monorepo 信号
    const hasWorkspaceSignal = signals.some((s) => s.ruleId === 'manifest:workspace');

    if (hasWorkspaceSignal) {
      return {
        value: 'modular-monolith',
        confidence: 0.8,
        signals: signals.filter((s) => s.ruleId === 'manifest:workspace'),
      };
    }

    return {
      value: 'monolith',
      confidence: 0.7,
      signals: [],
    };
  }

  /** 提取依赖摘要 */
  extractDependencySummary(signals: readonly Signal[]): DependencySummary {
    let packageManager: string | undefined;
    const directDeps: Array<{ name: string; version: string }> = [];
    let lockfilePath: string | undefined;
    for (const signal of signals) {
      packageManager = this.extractPackageManager(signal) ?? packageManager;
      directDeps.push(...this.extractDirectDeps(signal));
      lockfilePath = this.extractLockfilePath(signal) ?? lockfilePath;
    }
    return {
      packageManager,
      direct: directDeps,
      lockfilePath,
    };
  }

  private extractPackageManager(signal: Signal): string | undefined {
    if (signal.ruleId.startsWith('manifest:package-manager:')) {
      return signal.ruleId.replace('manifest:package-manager:', '');
    }
    return undefined;
  }

  private extractDirectDeps(signal: Signal): Array<{ name: string; version: string }> {
    if (signal.kind !== 'manifest' || signal.ruleId !== 'manifest:package-json') return [];
    const payload = signal.payload as Record<string, unknown>;
    if (!Array.isArray(payload.dependencies)) return [];
    const deps: Array<{ name: string; version: string }> = [];
    for (const dep of payload.dependencies) {
      if (typeof dep === 'string') {
        deps.push({ name: dep, version: '*' });
      }
    }
    return deps;
  }

  private extractLockfilePath(signal: Signal): string | undefined {
    if (signal.kind === 'lockfile') {
      return signal.file;
    }
    return undefined;
  }
}
