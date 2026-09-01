// 语言聚合器：加权投票 + TypeScript 优先级 + 置信度计算（Profiler 拆分重构产物）

import type { Signal, LanguageId, MatchResult } from './types';
import { SignalScorer, accumulateCandidate, type CandidateMap } from './profiler-scoring';

/** 置信度阈值：低于此值输出 unknown 而非硬猜（架构文档 §6.3） */
const CONFIDENCE_THRESHOLD = 0.6;

/** 语言聚合候选 */
interface LanguageCandidate {
  readonly language: LanguageId;
  readonly score: number;
  readonly signals: readonly Signal[];
}

/** 从候选 Map 中选出得分最高者 */
function selectBestCandidate(candidates: CandidateMap): LanguageCandidate | undefined {
  let bestCandidate: LanguageCandidate | undefined;
  for (const [language, { score, signals: sigs }] of candidates) {
    if (bestCandidate === undefined || score > bestCandidate.score) {
      bestCandidate = { language, score, signals: sigs };
    }
  }
  return bestCandidate;
}

/** 语言聚合器：聚合语言信号，输出语言判定结果 */
export class LanguageAggregator {
  /** 聚合语言信号：加权投票 + 置信度计算 */
  aggregate(signals: readonly Signal[]): MatchResult<LanguageId> {
    const candidates = this.collectCandidates(signals);
    this.applyTypeScriptPriority(candidates);
    const bestCandidate = selectBestCandidate(candidates);
    if (bestCandidate === undefined) {
      return this.makeUnknownResult('unknown', []);
    }
    const confidence = this.computeConfidence(bestCandidate, signals);
    if (confidence < CONFIDENCE_THRESHOLD) {
      return this.makeUnknownResult(bestCandidate.language, bestCandidate.signals);
    }
    return { value: bestCandidate.language, confidence, signals: bestCandidate.signals };
  }

  private collectCandidates(signals: readonly Signal[]): CandidateMap {
    const candidates = new Map<LanguageId, { score: number; signals: Signal[] }>();
    for (const signal of signals) {
      const language = this.extractLanguage(signal);
      if (language === undefined) continue;
      accumulateCandidate(candidates, language, signal);
    }
    return candidates;
  }

  /** TypeScript 优先级处理：同时有 javascript 和 typescript 时，typescript 优先 */
  private applyTypeScriptPriority(candidates: CandidateMap): void {
    if (candidates.has('javascript') && candidates.has('typescript')) {
      const jsCandidate = candidates.get('javascript');
      const tsCandidate = candidates.get('typescript');
      if (jsCandidate !== undefined && tsCandidate !== undefined) {
        tsCandidate.score += jsCandidate.score * 0.5;
        tsCandidate.signals.push(...jsCandidate.signals);
        candidates.delete('javascript');
      }
    }
  }

  private computeConfidence(bestCandidate: LanguageCandidate, signals: readonly Signal[]): number {
    const maxPossibleScore = SignalScorer.calculateMaxPossibleScore(signals, 'language');
    const baseConfidence =
      maxPossibleScore > 0 ? Math.min(bestCandidate.score / maxPossibleScore, 1) : 0;
    const avgWeight =
      bestCandidate.signals.length > 0 ? bestCandidate.score / bestCandidate.signals.length : 0;
    return bestCandidate.signals.length <= 1 && avgWeight < 0.8
      ? Math.min(baseConfidence, 0.5)
      : baseConfidence;
  }

  /** 从信号中提取语言 */
  private extractLanguage(signal: Signal): LanguageId | undefined {
    const payload = signal.payload as Record<string, unknown>;
    if (signal.kind === 'manifest') {
      return this.extractLanguageFromManifest(signal);
    }
    if (signal.kind === 'config' && typeof payload.language === 'string') {
      return payload.language as LanguageId;
    }
    if (signal.kind === 'ext-stat') {
      const ext = signal.ruleId.replace('ext-stat:', '');
      return this.mapExtToLanguage(ext);
    }
    return undefined;
  }

  private extractLanguageFromManifest(signal: Signal): LanguageId | undefined {
    if (signal.ruleId === 'manifest:package-json') return 'javascript';
    if (signal.ruleId === 'manifest:typescript-dep') return 'typescript';
    if (
      signal.ruleId === 'manifest:pyproject' ||
      signal.ruleId === 'manifest:requirements-txt' ||
      signal.ruleId === 'manifest:setup-py' ||
      signal.ruleId === 'manifest:pipfile'
    )
      return 'python';
    if (signal.ruleId === 'manifest:pom-xml') return 'java';
    if (signal.ruleId === 'manifest:go-mod') return 'go';
    if (signal.ruleId === 'manifest:cargo-toml') return 'rust';
    if (signal.ruleId === 'manifest:composer-json') return 'php';
    if (signal.ruleId === 'manifest:gemfile') return 'ruby';
    if (signal.ruleId === 'manifest:csproj') return 'csharp';
    return undefined;
  }

  /** 扩展名 → 语言映射 */
  private mapExtToLanguage(ext: string): LanguageId | undefined {
    const map: Record<string, LanguageId> = {
      ts: 'typescript',
      tsx: 'typescript',
      mts: 'typescript',
      cts: 'typescript',
      js: 'javascript',
      jsx: 'javascript',
      mjs: 'javascript',
      cjs: 'javascript',
      py: 'python',
      pyi: 'python',
      java: 'java',
      go: 'go',
      rs: 'rust',
      cs: 'csharp',
      php: 'php',
      rb: 'ruby',
      kt: 'kotlin',
      swift: 'swift',
    };
    return map[ext];
  }

  /** 构建 unknown 结果 */
  private makeUnknownResult(value: string, signals: readonly Signal[]): MatchResult<LanguageId> {
    return {
      value: value as LanguageId,
      confidence: 0,
      signals,
    };
  }
}
