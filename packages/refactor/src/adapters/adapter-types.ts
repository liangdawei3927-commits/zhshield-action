import type { IssueSeverity } from '@zh/shared';
import type { ParsedFile } from '../ast-helper';
import type { CodeSmell, RefactorConfig } from '../types';

export interface DetectorSet {
  name: string;
  detect: (parsed: ParsedFile, allFiles: ParsedFile[], config: RefactorConfig) => CodeSmell[];
}

/** makeSmell 参数对象 — 替代 12 个位置参数 */
export interface SmellParams {
  ruleId: string;
  severity: IssueSeverity;
  message: string;
  filePath: string;
  line: number;
  column: number;
  metric: string;
  value: number;
  threshold: number;
  suggestion: {
    type: string;
    description: string;
    priority: 'high' | 'medium' | 'low';
    effort: 'small' | 'medium' | 'large';
    autoFixable: boolean;
  };
  endLine?: number;
  endColumn?: number;
}

export function makeSmell(params: SmellParams): CodeSmell {
  const {
    ruleId, severity, message, filePath, line, column,
    metric, value, threshold, suggestion, endLine, endColumn,
  } = params;

  return {
    id: `${ruleId}:${filePath}:${line}:${column}`,
    ruleId,
    severity,
    message,
    category: 'structural',
    location: {
      filePath,
      line,
      column,
      endLine: endLine ?? line,
      endColumn: endColumn ?? column,
    },
    context: { metric, value, threshold },
    suggestion,
  };
}
