// 框架聚合器：加权投票 + 置信度过滤（Profiler 拆分重构产物）

import type { Signal, LanguageId, MatchResult } from './types';
import { SignalScorer, accumulateCandidate, type CandidateMap } from './profiler-scoring';

/** 置信度阈值：低于此值不输出框架判定 */
const CONFIDENCE_THRESHOLD = 0.6;

/** 框架聚合器：聚合框架信号，输出框架判定列表 */
export class FrameworkAggregator {
  /** 聚合框架信号：加权投票 */
  aggregate(
    signals: readonly Signal[],
    primaryLanguage: LanguageId,
  ): readonly MatchResult<string>[] {
    const candidates = this.collectCandidates(signals, primaryLanguage);
    return this.buildResults(candidates, signals);
  }

  private collectCandidates(signals: readonly Signal[], primaryLanguage: LanguageId): CandidateMap {
    const candidates = new Map<string, { score: number; signals: Signal[] }>();
    for (const signal of signals) {
      const framework = this.extractFramework(signal, primaryLanguage);
      if (framework === undefined) continue;
      accumulateCandidate(candidates, framework, signal);
    }
    return candidates;
  }

  /** 按得分排序，只返回置信度 >= 阈值的框架 */
  private buildResults(
    candidates: CandidateMap,
    signals: readonly Signal[],
  ): MatchResult<string>[] {
    const results: MatchResult<string>[] = [];
    for (const [framework, { score, signals: sigs }] of candidates) {
      const maxPossibleScore = SignalScorer.calculateMaxPossibleScore(signals, 'framework');
      const confidence = maxPossibleScore > 0 ? Math.min(score / maxPossibleScore, 1) : 0;
      if (confidence >= CONFIDENCE_THRESHOLD) {
        results.push({ value: framework, confidence, signals: sigs });
      }
    }
    return results;
  }

  /** 从信号中提取框架 */
  private extractFramework(signal: Signal, primaryLanguage: LanguageId): string | undefined {
    const payload = signal.payload as Record<string, unknown>;

    if (signal.kind === 'config' && typeof payload.framework === 'string') {
      return payload.framework;
    }

    if (signal.kind === 'manifest') {
      if (typeof payload.framework === 'string') return payload.framework;
      const deps = payload.dependencies ?? payload.deps;
      if (Array.isArray(deps)) {
        return this.inferFrameworkFromDeps(deps, primaryLanguage);
      }
    }

    return undefined;
  }

  /** 从依赖列表推断框架 */
  private inferFrameworkFromDeps(deps: unknown[], language: LanguageId): string | undefined {
    // 框架关键词映射（简化版，完整版在 framework-map.ts）
    const frameworkKeywords: Record<LanguageId, Array<{ name: string; keywords: string[] }>> = {
      typescript: [
        { name: 'Next.js', keywords: ['next'] },
        { name: 'NestJS', keywords: ['@nestjs/core', '@nestjs/common'] },
        { name: 'React', keywords: ['react', 'react-dom'] },
        { name: 'Vue', keywords: ['vue', '@vue/cli-service'] },
        { name: 'Express', keywords: ['express'] },
        { name: 'Fastify', keywords: ['fastify'] },
      ],
      javascript: [
        { name: 'Next.js', keywords: ['next'] },
        { name: 'NestJS', keywords: ['@nestjs/core', '@nestjs/common'] },
        { name: 'React', keywords: ['react', 'react-dom'] },
        { name: 'Vue', keywords: ['vue', '@vue/cli-service'] },
        { name: 'Express', keywords: ['express'] },
        { name: 'Fastify', keywords: ['fastify'] },
      ],
      python: [
        { name: 'Django', keywords: ['django'] },
        { name: 'FastAPI', keywords: ['fastapi'] },
        { name: 'Flask', keywords: ['flask'] },
      ],
      java: [
        { name: 'Spring Boot', keywords: ['spring-boot-starter'] },
        { name: 'Spring', keywords: ['spring-web', 'spring-webmvc'] },
      ],
      go: [
        { name: 'Gin', keywords: ['github.com/gin-gonic/gin'] },
        { name: 'Echo', keywords: ['github.com/labstack/echo'] },
      ],
      rust: [
        { name: 'Axum', keywords: ['axum'] },
        { name: 'Actix-web', keywords: ['actix-web'] },
      ],
      php: [
        { name: 'Laravel', keywords: ['laravel/framework', 'laravel'] },
        { name: 'Symfony', keywords: ['symfony/framework-bundle'] },
      ],
      ruby: [{ name: 'Rails', keywords: ['rails'] }],
      csharp: [],
      kotlin: [],
      swift: [],
      c: [],
      cpp: [],
      dart: [],
      shell: [],
    };

    const candidates = frameworkKeywords[language] ?? [];
    for (const candidate of candidates) {
      if (
        candidate.keywords.some((kw) => deps.some((d) => typeof d === 'string' && d.includes(kw)))
      ) {
        return candidate.name;
      }
    }

    return undefined;
  }
}
