import type { IssueSeverity } from '@zh/shared';

export interface CodeLocation {
  filePath: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

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

export interface FileSmellReport {
  filePath: string;
  totalSmells: number;
  smells: CodeSmell[];
  maintainabilityScore: number;
  refactorPriority: 'critical' | 'high' | 'medium' | 'low';
}

export interface ByCategory {
  structural: number;
  coupling: number;
  inheritance: number;
}

export type SmellCategory = keyof ByCategory;
export type SmellSeverity = IssueSeverity;

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
    'long-method', 'large-class', 'long-parameter-list',
    'deep-nesting', 'data-clumps', 'primitive-obsession',
    'feature-envy', 'inappropriate-intimacy', 'middle-man',
    'message-chains', 'refused-bequest', 'lazy-class', 'switch-statement',
    'oversized-file', 'mixed-responsibilities', 'duplicated-code',
    'callback-hell', 'oversized-component', 'god-object', 'data-class',
  ],
};
