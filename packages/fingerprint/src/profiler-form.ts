// 形态语义判定器：消费语言结果 + 形态信号交叉验证（Profiler 拆分重构产物）

import type { Signal, LanguageId, ProductFormId } from './types';

/** 形态聚合候选 */
export interface FormCandidate {
  readonly form: ProductFormId;
  readonly score: number;
  readonly signals: readonly Signal[];
  readonly isDecisive: boolean; // 决定性信号存在（架构文档 §6.2 形态识别信号表）
}

/** 形态验证入参：validate* 家族共用的 (form, score, language, signals) 参数泥团封装 */
interface FormValidationContext {
  readonly form: ProductFormId;
  readonly score: number;
  readonly language: LanguageId;
  readonly signals: readonly Signal[];
}

/** 计算形态置信度 */
export function calculateFormConfidence(score: number, isDecisive: boolean): number {
  // 决定性信号存在 → 高置信度
  if (isDecisive) {
    return Math.min(0.9 + score * 0.1, 1.0);
  }

  // 非决定性信号 → 基础置信度
  const baseConfidence = 0.5;
  return Math.min(baseConfidence + score * 0.3, 0.85);
}

/** 形态判定器：形态信号聚合 + 语言上下文交叉验证 */
export class FormDeterminer {
  /**
   * 形态语义判定（架构文档 §6.4 / C10）
   * 消费语言结果 + 形态信号交叉验证
   */
  determine(signals: readonly Signal[], primaryLanguage: LanguageId): readonly FormCandidate[] {
    const candidates = this.collectCandidates(signals);
    const validatedCandidates = this.validateCandidates(candidates, primaryLanguage);
    validatedCandidates.sort((a, b) => b.score - a.score);
    return validatedCandidates;
  }

  private collectCandidates(
    signals: readonly Signal[],
  ): Map<ProductFormId, { score: number; signals: Signal[]; isDecisive: boolean }> {
    const candidates = new Map<
      ProductFormId,
      { score: number; signals: Signal[]; isDecisive: boolean }
    >();
    const addCandidate = (form: ProductFormId, signal: Signal, isDecisive: boolean): void => {
      const existing = candidates.get(form);
      if (existing) {
        existing.score += signal.weight;
        existing.signals.push(signal);
        if (isDecisive) existing.isDecisive = true;
      } else {
        candidates.set(form, { score: signal.weight, signals: [signal], isDecisive });
      }
    };
    for (const signal of signals) {
      if (signal.kind !== 'form') continue;
      const payload = signal.payload as Record<string, unknown>;
      if (typeof payload.productForm === 'string') {
        addCandidate(payload.productForm as ProductFormId, signal, this.isDecisiveSignal(signal));
        continue;
      }
      const form = this.mapSignal(signal);
      if (form !== undefined) {
        addCandidate(form, signal, this.isDecisiveSignal(signal));
      }
    }
    return candidates;
  }

  private validateCandidates(
    candidates: Map<ProductFormId, { score: number; signals: Signal[]; isDecisive: boolean }>,
    primaryLanguage: LanguageId,
  ): FormCandidate[] {
    const validatedCandidates: FormCandidate[] = [];
    for (const [form, { score, signals: sigs, isDecisive }] of candidates) {
      const validatedScore = this.validateWithContext({
        form,
        score,
        language: primaryLanguage,
        signals: sigs,
      });
      validatedCandidates.push({
        form,
        score: validatedScore,
        signals: sigs,
        isDecisive,
      });
    }
    return validatedCandidates;
  }

  /** 判断是否为决定性形态信号（架构文档 §6.2 形态识别信号表） */
  private isDecisiveSignal(signal: Signal): boolean {
    const ruleId = signal.ruleId;
    return (
      ruleId === 'form:electron' ||
      ruleId === 'form:tauri' ||
      ruleId === 'form:podfile' ||
      ruleId === 'form:xcodeproj' ||
      ruleId === 'form:android-gradle' ||
      ruleId === 'form:android-manifest' ||
      ruleId === 'form:miniapp-project-config'
    );
  }

  private mapSignal(signal: Signal): ProductFormId | undefined {
    const FORM_RULE_MAP: Record<string, ProductFormId> = {
      'form:electron': 'pc',
      'form:tauri': 'pc',
      'form:podfile': 'ios',
      'form:xcodeproj': 'ios',
      'form:android-gradle': 'android',
      'form:android-manifest': 'android',
      'form:miniapp-project-config': 'miniapp',
      'form:index-html': 'h5',
      'form:web-bundler': 'h5',
      'form:server-framework': 'backend',
      'form:db-config': 'backend',
      'form:react-native': 'mobile',
      'form:taro': 'miniapp',
    };
    return FORM_RULE_MAP[signal.ruleId];
  }

  /** 语言上下文验证形态判定 */
  private validateWithContext(ctx: FormValidationContext): number {
    const mobileScore = this.validateMobile(ctx);
    if (mobileScore !== undefined) return mobileScore;
    const pcScore = this.validatePc(ctx);
    if (pcScore !== undefined) return pcScore;
    const miniappScore = this.validateMiniapp(ctx);
    if (miniappScore !== undefined) return miniappScore;
    const backendScore = this.validateBackend(ctx.form, ctx.score, ctx.signals);
    if (backendScore !== undefined) return backendScore;
    return ctx.score;
  }

  /** React Native + iOS/Android 信号 → 移动端（RN 壳），语言是 TS 时降权 */
  private validateMobile(ctx: FormValidationContext): number | undefined {
    if (ctx.form !== 'ios' && ctx.form !== 'android') return undefined;
    const hasRNSignal = ctx.signals.some((s) => s.ruleId === 'form:react-native');
    if (hasRNSignal && ctx.language === 'typescript') {
      return ctx.score * 0.7;
    }
    return undefined;
  }

  /** Electron + PC 信号 → 确认 PC，升权 */
  private validatePc(ctx: FormValidationContext): number | undefined {
    if (ctx.form !== 'pc') return undefined;
    const hasElectronSignal = ctx.signals.some((s) => s.ruleId === 'form:electron');
    if (hasElectronSignal && (ctx.language === 'typescript' || ctx.language === 'javascript')) {
      return ctx.score * 1.2;
    }
    return undefined;
  }

  /** 小程序 + Taro/uni-app → 确认小程序，升权 */
  private validateMiniapp(ctx: FormValidationContext): number | undefined {
    if (ctx.form !== 'miniapp') return undefined;
    const hasTaroSignal = ctx.signals.some((s) => s.ruleId === 'form:taro');
    const hasUniAppSignal = ctx.signals.some((s) => s.ruleId === 'form:uni-app');
    if ((hasTaroSignal || hasUniAppSignal) && ctx.language === 'typescript') {
      return ctx.score * 1.2;
    }
    return undefined;
  }

  /** 后端形态 + 服务端框架 → 确认后端，升权 */
  private validateBackend(
    form: ProductFormId,
    score: number,
    signals: readonly Signal[],
  ): number | undefined {
    if (form !== 'backend') return undefined;
    const hasServerFramework = signals.some((s) => s.ruleId === 'form:server-framework');
    if (hasServerFramework) {
      return score * 1.2;
    }
    return undefined;
  }
}
