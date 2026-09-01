// 问题集生成层（架构文档 §7）：按规则库 serves 声明驱动按需追问
// 阶梯式触发：架构 → 语言 → 形态 → 环境

import type {
  ProjectProfile,
  LanguageId,
  ProductFormId,
  ArchitectureForm,
  MatchResult,
} from './types';

// ─── 常量 ───

/** 置信度阈值 */
const CONFIDENCE_THRESHOLDS = {
  /** 高置信度：只展示不确认 */
  high: 0.9,
  /** 中置信度：需要确认 */
  medium: 0.6,
  /** 低置信度：输出 unknown 强制确认 */
  low: 0.3,
} as const;

/** 问题类型 */
export type QuestionType = 'architecture' | 'language' | 'form' | 'environment' | 'framework';

/** 问题优先级 */
export type QuestionPriority = 'required' | 'recommended' | 'optional';

/** 单个问题 */
export interface Question {
  /** 问题 ID */
  readonly id: string;
  /** 问题类型 */
  readonly type: QuestionType;
  /** 问题标题 */
  readonly title: string;
  /** 问题描述 */
  readonly description: string;
  /** 问题优先级 */
  readonly priority: QuestionPriority;
  /** 可选项列表 */
  readonly options: readonly QuestionOption[];
  /** 当前值（预填） */
  readonly currentValue?: string;
  /** 支撑信号（可追溯） */
  readonly signals: readonly string[];
  /** 触发原因 */
  readonly reason: string;
}

/** 问题选项 */
export interface QuestionOption {
  /** 选项值 */
  readonly value: string;
  /** 选项标签 */
  readonly label: string;
  /** 选项描述 */
  readonly description?: string;
  /** 是否为推荐值 */
  readonly recommended?: boolean;
}

/** 规则库能力声明（架构文档 §5.2） */
export interface RuleServes {
  /** 支持的语言 */
  readonly languages: readonly LanguageId[];
  /** 支持的产品形态 */
  readonly productForms: readonly ProductFormId[];
  /** 支持的架构形态 */
  readonly architectures: readonly ArchitectureForm[];
}

// ─── 问题构建辅助（纯函数） ───

function buildArchitectureOptions(architecture: MatchResult<ArchitectureForm>): QuestionOption[] {
  const options: QuestionOption[] = [
    { value: 'monolith', label: '单体架构', description: '所有代码在一个部署单元中' },
    {
      value: 'modular-monolith',
      label: '模块化单体',
      description: '代码在一个部署单元中，但模块边界清晰',
    },
    { value: 'microservices', label: '微服务架构', description: '多个独立部署的服务' },
  ];
  const recommendedIndex = options.findIndex((o) => o.value === architecture.value);
  if (recommendedIndex >= 0) {
    options[recommendedIndex] = { ...options[recommendedIndex], recommended: true };
  }
  return options;
}

function buildArchitectureQuestion(
  profile: ProjectProfile,
  architecture: MatchResult<ArchitectureForm>,
  options: QuestionOption[],
): Question {
  return {
    id: 'architecture-confirm',
    type: 'architecture',
    title: '项目架构形态',
    description: '请选择项目的主要架构形态',
    priority: 'required',
    options,
    currentValue: architecture.value,
    signals: architecture.signals.map((s) => s.ruleId),
    reason:
      profile.lastConfirmedAt === undefined
        ? '首次注册，需要确认架构形态'
        : `架构形态置信度较低 (${(architecture.confidence * 100).toFixed(0)}%)`,
  };
}

function buildFormOptions(
  forms: readonly ProductFormId[],
  current: ProductFormId,
): QuestionOption[] {
  return forms.map((form) => ({
    value: form,
    label: getFormLabel(form),
    recommended: form === current,
  }));
}

function buildFormQuestion(
  productForm: MatchResult<ProductFormId>,
  options: QuestionOption[],
): Question {
  return {
    id: 'form-confirm',
    type: 'form',
    title: '项目交付物形态',
    description: '请选择项目的主要交付物形态',
    priority: 'optional',
    options,
    currentValue: productForm.value,
    signals: productForm.signals.map((s) => s.ruleId),
    reason: `形态判定置信度较低 (${(productForm.confidence * 100).toFixed(0)}%)，可选确认`,
  };
}

function buildFrameworkQuestion(frameworks: readonly MatchResult<string>[]): Question {
  const options: QuestionOption[] = frameworks.map((f) => ({
    value: f.value,
    label: f.value,
    recommended: true,
  }));
  return {
    id: 'framework-confirm',
    type: 'framework',
    title: '项目框架',
    description: '以下框架判定置信度较低，请确认',
    priority: 'recommended',
    options,
    signals: frameworks.flatMap((f) => f.signals.map((s) => s.ruleId)),
    reason: `框架判定置信度较低`,
  };
}

function getLanguageLabel(language: LanguageId): string {
  const labels: Record<string, string> = {
    typescript: 'TypeScript',
    javascript: 'JavaScript',
    python: 'Python',
    java: 'Java',
    go: 'Go',
    rust: 'Rust',
    csharp: 'C#',
    php: 'PHP',
    ruby: 'Ruby',
    kotlin: 'Kotlin',
    swift: 'Swift',
    c: 'C',
    cpp: 'C++',
    dart: 'Dart',
    shell: 'Shell',
  };
  return labels[language] ?? language;
}

function getFormLabel(form: ProductFormId): string {
  const labels: Record<string, string> = {
    website: '官网',
    admin: '后台管理',
    mobile: '移动端',
    miniapp: '小程序',
    pc: 'PC 桌面端',
    ios: 'iOS',
    android: 'Android',
    h5: 'H5/Web',
    backend: '后端服务',
  };
  return labels[form] ?? form;
}

function getEnvironmentLabel(env: string): string {
  const labels: Record<string, string> = {
    node: 'Node.js',
    python: 'Python',
    docker: 'Docker',
    ci: 'CI/CD',
    browser: '浏览器',
  };
  return labels[env] ?? env;
}

// ─── QuestionSet 类 ───

export class QuestionSet {
  private readonly serves: RuleServes;

  constructor(serves: RuleServes) {
    this.serves = serves;
  }

  /**
   * 根据项目画像生成待确认问题集（架构文档 §7.1）
   * @param profile 项目画像
   * @returns 问题列表（按优先级排序）
   */
  generate(profile: ProjectProfile): readonly Question[] {
    const questions: Question[] = [];
    // 1. 架构形态问题（首次注册必选；或置信度 < 0.7）
    this.pushIfDefined(questions, this.generateArchitectureQuestion(profile));
    // 2. 语言问题（置信度阶梯触发）
    this.pushIfDefined(questions, this.generateLanguageQuestion(profile));
    // 3. 产品形态问题（高置信直接判定不确认；低置信可选确认）
    this.pushIfDefined(questions, this.generateFormQuestion(profile));
    // 4. 环境问题（非阻断）
    this.pushIfDefined(questions, this.generateEnvironmentQuestion(profile));
    // 5. 框架问题（低置信度时）
    this.pushIfDefined(questions, this.generateFrameworkQuestion(profile));
    // 按优先级排序：required > recommended > optional
    return this.sortByPriority(questions);
  }

  private pushIfDefined(questions: Question[], question: Question | undefined): void {
    if (question !== undefined) questions.push(question);
  }

  /**
   * 检查是否需要用户确认
   * @param profile 项目画像
   * @returns 是否需要确认
   */
  needsConfirmation(profile: ProjectProfile): boolean {
    const questions = this.generate(profile);
    return questions.some((q) => q.priority === 'required');
  }

  /**
   * 获取需要确认的问题
   * @param profile 项目画像
   * @returns 需要确认的问题列表
   */
  getRequiredQuestions(profile: ProjectProfile): readonly Question[] {
    return this.generate(profile).filter((q) => q.priority === 'required');
  }

  // ─── 问题生成方法 ───

  /** 生成架构形态问题 */
  private generateArchitectureQuestion(profile: ProjectProfile): Question | undefined {
    const { architecture } = profile;
    const needsQuestion = profile.lastConfirmedAt === undefined || architecture.confidence < 0.7;
    if (!needsQuestion) return undefined;
    if (this.serves.architectures.length === 0) return undefined;
    const options = buildArchitectureOptions(architecture);
    return buildArchitectureQuestion(profile, architecture, options);
  }

  /** 生成语言问题 */
  private generateLanguageQuestion(profile: ProjectProfile): Question | undefined {
    const primaryTarget = profile.targets[0];
    if (primaryTarget === undefined) return undefined;
    const { language } = primaryTarget;
    if (language.confidence >= CONFIDENCE_THRESHOLDS.high) return undefined;
    if (language.confidence < CONFIDENCE_THRESHOLDS.medium) {
      return this.makeLanguageQuestion(
        profile,
        'required',
        `语言判定置信度较低 (${(language.confidence * 100).toFixed(0)}%)，需要人工确认`,
      );
    }
    return this.makeLanguageQuestion(
      profile,
      'recommended',
      `语言判定置信度中等 (${(language.confidence * 100).toFixed(0)}%)，建议确认`,
    );
  }

  /** 构建语言问题 */
  private makeLanguageQuestion(
    profile: ProjectProfile,
    priority: QuestionPriority,
    reason: string,
  ): Question | undefined {
    const primaryTarget = profile.targets[0];
    if (primaryTarget === undefined) return undefined;

    const supportedLanguages = this.serves.languages;
    if (supportedLanguages.length === 0) return undefined;

    const options: QuestionOption[] = supportedLanguages.map((lang) => ({
      value: lang,
      label: getLanguageLabel(lang),
      recommended: lang === primaryTarget.language.value,
    }));

    return {
      id: 'language-confirm',
      type: 'language',
      title: '项目主要语言',
      description: '请选择项目的主要编程语言',
      priority,
      options,
      currentValue: primaryTarget.language.value,
      signals: primaryTarget.language.signals.map((s) => s.ruleId),
      reason,
    };
  }

  /** 生成产品形态问题 */
  private generateFormQuestion(profile: ProjectProfile): Question | undefined {
    const primaryTarget = profile.targets[0];
    if (primaryTarget === undefined) return undefined;
    const { productForm } = primaryTarget;
    if (productForm === undefined) return undefined;
    if (!this.serves.productForms.includes(productForm.value)) return undefined;
    if (productForm.confidence >= CONFIDENCE_THRESHOLDS.high) return undefined;
    const options = buildFormOptions(this.serves.productForms, productForm.value);
    return buildFormQuestion(productForm, options);
  }

  /** 生成环境问题 */
  private generateEnvironmentQuestion(profile: ProjectProfile): Question | undefined {
    // 环境问题：非阻断，首次扫顺带展示（架构文档 §7.1）
    if (profile.environments.length === 0) return undefined;

    const environments = profile.environments.map((e) => e.value);

    return {
      id: 'environment-display',
      type: 'environment',
      title: '检测到的运行环境',
      description: `检测到以下运行环境：${environments.join(', ')}`,
      priority: 'optional',
      options: environments.map((env) => ({
        value: env,
        label: getEnvironmentLabel(env),
      })),
      signals: profile.environments.flatMap((e) => e.signals.map((s) => s.ruleId)),
      reason: '首次扫描，展示检测到的环境',
    };
  }

  /** 生成框架问题 */
  private generateFrameworkQuestion(profile: ProjectProfile): Question | undefined {
    const primaryTarget = profile.targets[0];
    if (primaryTarget === undefined) return undefined;
    const { frameworks } = primaryTarget;
    if (frameworks.length === 0) return undefined;
    const lowConfidenceFrameworks = frameworks.filter(
      (f) => f.confidence < CONFIDENCE_THRESHOLDS.medium,
    );
    if (lowConfidenceFrameworks.length === 0) return undefined;
    return buildFrameworkQuestion(lowConfidenceFrameworks);
  }

  // ─── 辅助方法 ───

  /** 按优先级排序 */
  private sortByPriority(questions: readonly Question[]): readonly Question[] {
    const priorityOrder: Record<QuestionPriority, number> = {
      required: 0,
      recommended: 1,
      optional: 2,
    };

    return questions.toSorted((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);
  }
}

// ─── 导出工厂函数 ───

/**
 * 创建 QuestionSet 实例
 * @param serves 规则库能力声明
 */
export function createQuestionSet(serves: RuleServes): QuestionSet {
  return new QuestionSet(serves);
}

/**
 * 创建默认规则库能力声明（支持所有语言和形态）
 */
export function createDefaultServes(): RuleServes {
  return {
    languages: [
      'typescript',
      'javascript',
      'python',
      'java',
      'go',
      'rust',
      'csharp',
      'php',
      'ruby',
      'kotlin',
      'swift',
    ],
    productForms: [
      'website',
      'admin',
      'mobile',
      'miniapp',
      'pc',
      'ios',
      'android',
      'h5',
      'backend',
    ],
    architectures: ['monolith', 'modular-monolith', 'microservices'],
  };
}
