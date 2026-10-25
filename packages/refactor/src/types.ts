import type { IssueSeverity } from '@zh/shared';

/** 代码位置：起止行列（1-based） */
export interface CodeLocation {
  filePath: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

/** 代码坏味道：命中规则、定位、度量上下文（指标值与阈值）与重构建议 */
export interface CodeSmell {
  id: string;
  ruleId: string;
  category: string;
  severity: IssueSeverity;
  message: string;
  location: CodeLocation;
  context: {
    className?: string;
    methodName?: string;
    metric: string;
    value: number;
    threshold: number;
  };
  suggestion: {
    type: string;
    description: string;
    priority: 'high' | 'medium' | 'low';
    effort: 'small' | 'medium' | 'large';
    autoFixable: boolean;
  };
}

/** 单文件坏味道报告：文件定位、坏味道列表、可维护性评分与重构优先级 */
export interface FileSmellReport {
  filePath: string;
  totalSmells: number;
  smells: CodeSmell[];
  maintainabilityScore: number;
  refactorPriority: 'critical' | 'high' | 'medium' | 'low';
}

/** 重构报告：全量扫描的时间、范围、分类/严重级分布、逐文件明细与汇总建议 */
export interface RefactorReport {
  timestamp: string;
  projectRoot: string;
  totalFiles: number;
  scannedFiles: number;
  totalSmells: number;
  byCategory: Record<string, number>;
  bySeverity: Record<IssueSeverity, number>;
  files: FileSmellReport[];
  summary: {
    criticalFiles: number;
    needsImmediateAction: number;
    suggestionsByType: Record<string, number>;
  };
}

/** 文本替换编辑 — 原子化的代码修改单元 */
export interface TextEdit {
  filePath: string;
  /** 1-based 行号 */
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  /** 替换后的文本 */
  replacement: string;
}

/** 自动修复建议 — 针对一个 CodeSmell 的一组编辑操作 */
export interface Fix {
  smellId: string;
  ruleId: string;
  description: string;
  edits: TextEdit[];
}

/** 修复执行结果 */
export interface FixResult {
  fixed: number;
  failed: number;
  errors: string[];
}

/** 重构配置：度量阈值、规则 → 严重级映射与启用的规则清单 */
export interface RefactorConfig {
  thresholds: {
    maxMethodLines: number;
    maxClassLines: number;
    maxParameters: number;
    maxNestingDepth: number;
    maxClassMethods: number;
    maxComplexity: number;
    minClassLines: number;
    featureEnvyRatio: number;
    maxFileLines: number;
    maxTopLevelExports: number;
    maxComponentLines: number;
    maxJsxNestingDepth: number;
    maxCallbackHandlers: number;
    minDuplicateLines: number;
    minDataClassFields: number;
    maxDataClassMethods: number;
    maxGodObjectMethods: number;
    maxInjectDependencies: number;
    minResponsibilities: number;
  };
  severities: Record<string, IssueSeverity>;
  enabledRules: string[];
}

/** 默认重构配置：内置度量阈值、规则严重级映射与全量启用规则集（调用方可整体覆盖） */
export const DEFAULT_CONFIG: RefactorConfig = {
  thresholds: {
    maxMethodLines: 80,
    maxClassLines: 300,
    maxParameters: 4,
    maxNestingDepth: 3,
    maxClassMethods: 20,
    maxComplexity: 15,
    minClassLines: 15,
    featureEnvyRatio: 0.5,
    maxFileLines: 400,
    maxTopLevelExports: 10,
    maxComponentLines: 150,
    maxJsxNestingDepth: 5,
    maxCallbackHandlers: 5,
    minDuplicateLines: 5,
    minDataClassFields: 5,
    maxDataClassMethods: 1,
    maxGodObjectMethods: 20,
    maxInjectDependencies: 7,
    minResponsibilities: 3,
  },
  severities: {
    'long-method': 'warning',
    'large-class': 'error',
    'long-parameter-list': 'warning',
    'deep-nesting': 'warning',
    'data-clumps': 'info',
    'primitive-obsession': 'info',
    'feature-envy': 'warning',
    'inappropriate-intimacy': 'error',
    'middle-man': 'info',
    'message-chains': 'warning',
    'shotgun-surgery': 'warning',
    'refused-bequest': 'warning',
    'lazy-class': 'info',
    'switch-statement': 'warning',
    'oversized-file': 'warning',
    'mixed-responsibilities': 'warning',
    'duplicated-code': 'warning',
    'callback-hell': 'warning',
    'oversized-component': 'warning',
    'god-object': 'error',
    'data-class': 'warning',
  },
  enabledRules: [
    'long-method',
    'large-class',
    'long-parameter-list',
    'deep-nesting',
    'data-clumps',
    'primitive-obsession',
    'feature-envy',
    'inappropriate-intimacy',
    'middle-man',
    'message-chains',
    'refused-bequest',
    'lazy-class',
    'switch-statement',
    'oversized-file',
    // 'mixed-responsibilities' 默认下线（2026-10-25）：其"职责数" = 注释分区数 + 空行块数
    // + try 个数（structure-detectors.ts countResponsibilities），纯字面量代理，与职责无关。
    // 实测对自家代码库 32 处命中 0 处可用（22 行的 hook 被判 4 个职责），精确率 0%。
    // 误报回归集与真阳性样本见 __tests__/mixed-responsibilities-gate.test.ts；
    // 换语义信号重写并通过该回归集后，方可恢复默认启用。
    'duplicated-code',
    'callback-hell',
    'oversized-component',
    'god-object',
    'data-class',
  ],
};
