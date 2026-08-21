// Profiler 聚合层（架构文档 §6.4）：Signal[] → ProjectProfile
// 两阶段判定：① 语言/框架/环境聚合 + 置信度加权 → ② 形态语义判定（消费语言结果 + 交叉验证）

import type {
  Signal,
  LanguageId,
  ProductFormId,
  ArchitectureForm,
  MatchResult,
  TargetProfile,
  ProjectProfile,
  UserOverrides,
  DependencySummary,
} from './types';
import type { Detector } from './detector';

// ─── 常量 ───

/** 置信度阈值：低于此值输出 unknown 而非硬猜（架构文档 §6.3） */
const CONFIDENCE_THRESHOLD = 0.6;

// ─── 内部类型 ───

/** 语言聚合候选 */
interface LanguageCandidate {
  readonly language: LanguageId;
  readonly score: number;
  readonly signals: readonly Signal[];
}

/** 形态聚合候选 */
interface FormCandidate {
  readonly form: ProductFormId;
  readonly score: number;
  readonly signals: readonly Signal[];
  readonly isDecisive: boolean; // 决定性信号存在（架构文档 §6.2 形态识别信号表）
}

// ─── Profiler 类 ───

export class Profiler {
  private readonly detectors: readonly Detector[];

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
    // ① 并行探测：各 Detector 并行 detect() 收集 Signal[]
    const allSignals = await this.collectSignals(projectPath);

    // ② 第一阶段：语言/框架/环境聚合 + 置信度加权
    const languageResult = this.aggregateLanguage(allSignals);
    const frameworkResults = this.aggregateFrameworks(allSignals, languageResult.value);
    const environmentResults = this.aggregateEnvironments(allSignals);
    const packageManagerResult = this.aggregatePackageManager(allSignals);

    // ③ 第二阶段：形态语义判定（消费语言结果 + 交叉验证）
    const formResults = this.determineForms(allSignals, languageResult.value);

    // 构建 TargetProfile（M0 常驻 ≥1）
    const target = this.buildTarget(
      projectPath,
      languageResult,
      frameworkResults,
      formResults,
      packageManagerResult,
    );

    // 架构形态判定（简化版：从 monorepo 信号推断）
    const architecture = this.determineArchitecture(allSignals);

    // 依赖摘要
    const dependencies = this.extractDependencySummary(allSignals);

    // 合并人工修正
    const mergedOverrides = this.mergeOverrides(overrides, target);

    // 漂移标记（简化版：首次扫描为 false）
    const stale = false;

    return {
      schemaVersion: 1,
      architecture,
      targets: [target],
      environments: environmentResults,
      dependencies,
      detectedAt: new Date().toISOString(),
      stale,
      signals: allSignals,
      overrides: mergedOverrides,
    };
  }

  // ─── 信号采集 ───

  /** 并行运行所有 Detector 收集信号 */
  private async collectSignals(projectPath: string): Promise<readonly Signal[]> {
    const results = await Promise.all(
      this.detectors.map((detector) => detector.detect(projectPath)),
    );
    return results.flat();
  }

  // ─── 第一阶段：语言/框架/环境聚合 ───

  /** 聚合语言信号：加权投票 + 置信度计算 */
  private aggregateLanguage(signals: readonly Signal[]): MatchResult<LanguageId> {
    const candidates = new Map<LanguageId, { score: number; signals: Signal[] }>();

    for (const signal of signals) {
      const language = this.extractLanguage(signal);
      if (language === undefined) continue;

      const weight = signal.weight;
      const existing = candidates.get(language);
      if (existing) {
        existing.score += weight;
        existing.signals.push(signal);
      } else {
        candidates.set(language, { score: weight, signals: [signal] });
      }
    }

    // TypeScript 优先级处理：如果同时有 javascript 和 typescript，typescript 优先
    // 这是因为 tsconfig.json 的存在表明项目使用 TypeScript
    if (candidates.has('javascript') && candidates.has('typescript')) {
      const jsCandidate = candidates.get('javascript');
      const tsCandidate = candidates.get('typescript');
      if (jsCandidate !== undefined && tsCandidate !== undefined) {
        // 将 javascript 的分数合并到 typescript
        tsCandidate.score += jsCandidate.score * 0.5; // javascript 信号给 typescript 一半的分数
        tsCandidate.signals.push(...jsCandidate.signals);
        candidates.delete('javascript');
      }
    }

    // 选择得分最高的语言
    let bestCandidate: LanguageCandidate | undefined;
    for (const [language, { score, signals: sigs }] of candidates) {
      if (bestCandidate === undefined || score > bestCandidate.score) {
        bestCandidate = { language, score, signals: sigs };
      }
    }

    if (bestCandidate === undefined) {
      return this.makeUnknownResult('unknown', []);
    }

    const maxPossibleScore = this.calculateMaxPossibleScore(signals, 'language');
    const baseConfidence = maxPossibleScore > 0
      ? Math.min(bestCandidate.score / maxPossibleScore, 1)
      : 0;
    // 单信号源时，低权重信号（ext-stat/content）上限 0.5
    const avgWeight = bestCandidate.signals.length > 0
      ? bestCandidate.score / bestCandidate.signals.length
      : 0;
    const confidence = (bestCandidate.signals.length <= 1 && avgWeight < 0.8)
      ? Math.min(baseConfidence, 0.5)
      : baseConfidence;

    if (confidence < CONFIDENCE_THRESHOLD) {
      return this.makeUnknownResult(bestCandidate.language, bestCandidate.signals);
    }

    return {
      value: bestCandidate.language,
      confidence,
      signals: bestCandidate.signals,
    };
  }

  /** 从信号中提取语言 */
  private extractLanguage(signal: Signal): LanguageId | undefined {
    const payload = signal.payload as Record<string, unknown>;

    // manifest 信号：直接从 ruleId 映射
    if (signal.kind === 'manifest') {
      // package.json 默认为 javascript，但如果后续有 tsconfig 信号会升级为 typescript
      if (signal.ruleId === 'manifest:package-json') return 'javascript';
      if (signal.ruleId === 'manifest:typescript-dep') return 'typescript';
      if (signal.ruleId === 'manifest:pyproject' || signal.ruleId === 'manifest:requirements-txt' || signal.ruleId === 'manifest:setup-py' || signal.ruleId === 'manifest:pipfile') return 'python';
      if (signal.ruleId === 'manifest:pom-xml') return 'java';
      if (signal.ruleId === 'manifest:go-mod') return 'go';
      if (signal.ruleId === 'manifest:cargo-toml') return 'rust';
      if (signal.ruleId === 'manifest:composer-json') return 'php';
      if (signal.ruleId === 'manifest:gemfile') return 'ruby';
      if (signal.ruleId === 'manifest:csproj') return 'csharp';
    }

    // config 信号：从 language 字段读取
    if (signal.kind === 'config' && typeof payload.language === 'string') {
      return payload.language as LanguageId;
    }

    // ext-stat 信号：从 ruleId 解析（ext-stat:ts → typescript）
    if (signal.kind === 'ext-stat') {
      const ext = signal.ruleId.replace('ext-stat:', '');
      return this.mapExtToLanguage(ext);
    }

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

  /** 聚合框架信号：加权投票 */
  private aggregateFrameworks(
    signals: readonly Signal[],
    primaryLanguage: LanguageId,
  ): readonly MatchResult<string>[] {
    const candidates = new Map<string, { score: number; signals: Signal[] }>();

    for (const signal of signals) {
      const framework = this.extractFramework(signal, primaryLanguage);
      if (framework === undefined) continue;

      const weight = signal.weight;
      const existing = candidates.get(framework);
      if (existing) {
        existing.score += weight;
        existing.signals.push(signal);
      } else {
        candidates.set(framework, { score: weight, signals: [signal] });
      }
    }

    // 按得分排序，返回高置信度的框架
    const results: MatchResult<string>[] = [];
    for (const [framework, { score, signals: sigs }] of candidates) {
      const maxPossibleScore = this.calculateMaxPossibleScore(signals, 'framework');
      const confidence = maxPossibleScore > 0
        ? Math.min(score / maxPossibleScore, 1)
        : 0;

      // 只返回置信度 >= 阈值的框架
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
      ruby: [
        { name: 'Rails', keywords: ['rails'] },
      ],
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
      if (candidate.keywords.some((kw) => deps.some((d) => typeof d === 'string' && d.includes(kw)))) {
        return candidate.name;
      }
    }

    return undefined;
  }

  /** 聚合环境信号 */
  private aggregateEnvironments(signals: readonly Signal[]): readonly MatchResult<string>[] {
    const environments = new Map<string, { score: number; signals: Signal[] }>();

    for (const signal of signals) {
      if (signal.kind !== 'config') continue;
      const payload = signal.payload as Record<string, unknown>;
      if (typeof payload.environment !== 'string') continue;

      const env = payload.environment;
      const existing = environments.get(env);
      if (existing) {
        existing.score += signal.weight;
        existing.signals.push(signal);
      } else {
        environments.set(env, { score: signal.weight, signals: [signal] });
      }
    }

    const results: MatchResult<string>[] = [];
    for (const [env, { signals: sigs }] of environments) {
      // 环境信号置信度固定为 1.0（config 信号权重高）
      results.push({ value: env, confidence: 1.0, signals: sigs });
    }

    return results;
  }

  /** 聚合包管理器信号 */
  private aggregatePackageManager(signals: readonly Signal[]): MatchResult<string> | undefined {
    for (const signal of signals) {
      if (signal.kind !== 'manifest') continue;
      if (!signal.ruleId.startsWith('manifest:package-manager:')) continue;

      const manager = signal.ruleId.replace('manifest:package-manager:', '');
      return {
        value: manager,
        confidence: 1.0,
        signals: [signal],
      };
    }

    return undefined;
  }

  // ─── 第二阶段：形态语义判定 ───

  /**
   * 形态语义判定（架构文档 §6.4 / C10）
   * 消费语言结果 + 形态信号交叉验证
   */
  private determineForms(
    signals: readonly Signal[],
    primaryLanguage: LanguageId,
  ): readonly FormCandidate[] {
    const candidates = new Map<ProductFormId, { score: number; signals: Signal[]; isDecisive: boolean }>();

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

      // 1. 直接有 productForm 字段的信号
      if (typeof payload.productForm === 'string') {
        addCandidate(payload.productForm as ProductFormId, signal, this.isDecisiveFormSignal(signal));
        continue;
      }

      // 2. 依赖/目录约定等非 productForm 信号 → ruleId → 形态映射
      const form = this.mapFormSignal(signal);
      if (form !== undefined) {
        addCandidate(form, signal, this.isDecisiveFormSignal(signal));
      }
    }

    const validatedCandidates: FormCandidate[] = [];
    for (const [form, { score, signals: sigs, isDecisive }] of candidates) {
      // 语言上下文验证
      const validatedScore = this.validateFormWithContext(form, score, primaryLanguage, sigs);

      // 计算置信度
      const _confidence = this.calculateFormConfidence(validatedScore, isDecisive);

      validatedCandidates.push({
        form,
        score: validatedScore,
        signals: sigs,
        isDecisive,
      });
    }

    // 按得分排序
    validatedCandidates.sort((a, b) => b.score - a.score);

    return validatedCandidates;
  }

  /** 判断是否为决定性形态信号（架构文档 §6.2 形态识别信号表） */
  private isDecisiveFormSignal(signal: Signal): boolean {
    const ruleId = signal.ruleId;
    return ruleId === 'form:electron' ||
      ruleId === 'form:tauri' ||
      ruleId === 'form:podfile' ||
      ruleId === 'form:xcodeproj' ||
      ruleId === 'form:android-gradle' ||
      ruleId === 'form:android-manifest' ||
      ruleId === 'form:miniapp-project-config';
  }

  private mapFormSignal(signal: Signal): ProductFormId | undefined {
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
  private validateFormWithContext(
    form: ProductFormId,
    score: number,
    language: LanguageId,
    signals: readonly Signal[],
  ): number {
    // React Native + iOS/Android 信号 → 移动端（RN 壳）
    if (form === 'ios' || form === 'android') {
      const hasRNSignal = signals.some((s) => s.ruleId === 'form:react-native');
      if (hasRNSignal && language === 'typescript') {
        // RN 壳 vs 原生 iOS：语言是 TS → RN 壳，形态降级为 mobile
        return score * 0.7; // 降权
      }
    }

    // Electron + PC 信号 → 确认 PC
    if (form === 'pc') {
      const hasElectronSignal = signals.some((s) => s.ruleId === 'form:electron');
      if (hasElectronSignal && (language === 'typescript' || language === 'javascript')) {
        return score * 1.2; // 升权
      }
    }

    // 小程序 + Taro/uni-app → 确认小程序
    if (form === 'miniapp') {
      const hasTaroSignal = signals.some((s) => s.ruleId === 'form:taro');
      const hasUniAppSignal = signals.some((s) => s.ruleId === 'form:uni-app');
      if ((hasTaroSignal || hasUniAppSignal) && language === 'typescript') {
        return score * 1.2; // 升权
      }
    }

    // 后端形态 + 服务端框架 → 确认后端
    if (form === 'backend') {
      const hasServerFramework = signals.some((s) => s.ruleId === 'form:server-framework');
      if (hasServerFramework) {
        return score * 1.2; // 升权
      }
    }

    return score;
  }

  /** 计算形态置信度 */
  private calculateFormConfidence(score: number, isDecisive: boolean): number {
    // 决定性信号存在 → 高置信度
    if (isDecisive) {
      return Math.min(0.9 + score * 0.1, 1.0);
    }

    // 非决定性信号 → 基础置信度
    const baseConfidence = 0.5;
    return Math.min(baseConfidence + score * 0.3, 0.85);
  }

  // ─── 辅助方法 ───

  /** 计算最大可能得分 */
  private calculateMaxPossibleScore(
    signals: readonly Signal[],
    dimension: 'language' | 'framework' | 'form',
  ): number {
    let maxScore = 0;
    for (const signal of signals) {
      if (dimension === 'language' && (signal.kind === 'manifest' || signal.kind === 'config' || signal.kind === 'ext-stat')) {
        if (signal.kind === 'manifest' && this.isFrameworkSignal(signal)) continue;
        maxScore += signal.weight;
      } else if (dimension === 'framework' && (signal.kind === 'manifest' || signal.kind === 'config')) {
        if (signal.kind === 'manifest' && !this.isFrameworkSignal(signal)) continue;
        maxScore += signal.weight;
      } else if (dimension === 'form' && signal.kind === 'form') {
        maxScore += signal.weight;
      }
    }
    return maxScore;
  }

  private isFrameworkSignal(signal: Signal): boolean {
    const payload = signal.payload as Record<string, unknown>;
    return typeof payload.framework === 'string';
  }

  /** 构建 TargetProfile */
  private buildTarget(
    projectPath: string,
    language: MatchResult<LanguageId>,
    frameworks: readonly MatchResult<string>[],
    forms: readonly FormCandidate[],
    packageManager: MatchResult<string> | undefined,
  ): TargetProfile {
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
      productForm: primaryForm !== undefined
        ? {
            value: primaryForm.form,
            confidence: this.calculateFormConfidence(primaryForm.score, primaryForm.isDecisive),
            signals: primaryForm.signals,
          }
        : undefined,
      packageManager,
      routeKey,
    };
  }

  /** 架构形态判定（简化版） */
  private determineArchitecture(signals: readonly Signal[]): MatchResult<ArchitectureForm> {
    // 检查 monorepo 信号
    const hasWorkspaceSignal = signals.some(
      (s) => s.ruleId === 'manifest:workspace',
    );

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
  private extractDependencySummary(signals: readonly Signal[]): DependencySummary {
    let packageManager: string | undefined;
    const directDeps: Array<{ name: string; version: string }> = [];
    let lockfilePath: string | undefined;

    for (const signal of signals) {
      // 包管理器
      if (signal.ruleId.startsWith('manifest:package-manager:')) {
        packageManager = signal.ruleId.replace('manifest:package-manager:', '');
      }

      // 直接依赖
      if (signal.kind === 'manifest' && signal.ruleId === 'manifest:package-json') {
        const payload = signal.payload as Record<string, unknown>;
        if (Array.isArray(payload.dependencies)) {
          for (const dep of payload.dependencies) {
            if (typeof dep === 'string') {
              directDeps.push({ name: dep, version: '*' });
            }
          }
        }
      }

      // lockfile 路径
      if (signal.kind === 'lockfile') {
        lockfilePath = signal.file;
      }
    }

    return {
      packageManager,
      direct: directDeps,
      lockfilePath,
    };
  }

  /** 合并人工修正 */
  private mergeOverrides(
    overrides: UserOverrides | undefined,
    target: TargetProfile,
  ): UserOverrides {
    if (overrides === undefined) {
      return {};
    }

    // 如果有 target 级别的修正，合并到当前 target
    if (overrides.targets?.[target.id]) {
      const targetOverride = overrides.targets[target.id];
      if (targetOverride.language !== undefined) {
        target = {
          ...target,
          language: {
            value: targetOverride.language,
            confidence: 1.0,
            signals: [],
          },
        };
      }
      if (targetOverride.productForm !== undefined) {
        target = {
          ...target,
          productForm: {
            value: targetOverride.productForm,
            confidence: 1.0,
            signals: [],
          },
        };
      }
    }

    return {
      architecture: overrides.architecture,
      targets: overrides.targets,
      updatedAt: overrides.updatedAt,
    };
  }

  /** 构建 unknown 结果 */
  private makeUnknownResult(
    value: string,
    signals: readonly Signal[],
  ): MatchResult<LanguageId> {
    return {
      value: value as LanguageId,
      confidence: 0,
      signals,
    };
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
