import type { ParsedFile } from '../ast-helper';
import type { CodeSmell, RefactorConfig } from '../types';
import { makeSmell } from './adapter-types';

const IDENT_START = /[a-zA-Z_]/;

export function detectLongMethod(parsed: ParsedFile, config: RefactorConfig): CodeSmell[] {
  const smells: CodeSmell[] = [];

  for (const cls of parsed.classes) {
    for (const method of cls.members.methods) {
      checkLongMethod(parsed, config, smells, {
        name: `${cls.name}.${method.name}()`,
        container: `${cls.name}.`,
        lineCount: method.lineCount,
        complexity: method.complexity,
        nodeLine: method.node.getStart ? parsed.sourceFile.getLineAndCharacterOfPosition(method.node.getStart(parsed.sourceFile)).line + 1 : cls.startLine,
      });
    }
  }

  for (const fn of parsed.functions) {
    checkLongMethod(parsed, config, smells, {
      name: `${fn.name}()`,
      container: '',
      lineCount: fn.lineCount,
      complexity: fn.complexity,
      nodeLine: fn.startLine,
    });
  }

  return smells;
}

function checkLongMethod(
  parsed: ParsedFile,
  config: RefactorConfig,
  smells: CodeSmell[],
  params: { name: string; container: string; lineCount: number; complexity: number; nodeLine: number },
): void {
  const threshold = config.thresholds.maxMethodLines;
  const complexityThreshold = config.thresholds.maxComplexity;
  if (params.lineCount <= threshold && params.complexity <= complexityThreshold) return;

  const parts: string[] = [];
  if (params.lineCount > threshold) parts.push(`${params.lineCount} 行 (阈值 ${threshold})`);
  if (params.complexity > complexityThreshold) parts.push(`圈复杂度 ${params.complexity} (阈值 ${complexityThreshold})`);

  smells.push(makeSmell({
    ruleId: 'long-method',
    severity: config.severities['long-method'],
    message: `${params.container}${params.name} 过大 (${parts.join('，')})，建议拆分为更小的函数`,
    filePath: parsed.filePath, line: params.nodeLine, column: 1,
    metric: 'methodLineCount', value: Math.max(params.lineCount, params.complexity), threshold: Math.max(threshold, complexityThreshold),
    suggestion: {
      type: 'Extract Method',
      description: `将 ${params.container}${params.name} 按职责拆分为多个小函数，每个不超过 ${threshold} 行`,
      priority: params.lineCount > threshold * 1.5 ? 'high' : 'medium',
      effort: params.lineCount > threshold * 2 ? 'large' : 'small',
      autoFixable: false,
    },
  }));
}

export function detectLargeClass(parsed: ParsedFile, config: RefactorConfig): CodeSmell[] {
  const smells: CodeSmell[] = [];
  const lineThreshold = config.thresholds.maxClassLines;
  const methodThreshold = config.thresholds.maxClassMethods;

  for (const cls of parsed.classes) {
    if (cls.lineCount > lineThreshold || cls.members.methods.length > methodThreshold) {
      const issues: string[] = [];
      if (cls.lineCount > lineThreshold) issues.push(`${cls.lineCount} 行 (阈值 ${lineThreshold})`);
      if (cls.members.methods.length > methodThreshold) {
        issues.push(`${cls.members.methods.length} 个方法 (阈值 ${methodThreshold})`);
      }

      smells.push(makeSmell({
        ruleId: 'large-class',
        severity: config.severities['large-class'],
        message: `${cls.name} 过大 (${issues.join('，')})，建议按职责拆分`,
        filePath: parsed.filePath, line: cls.startLine, column: 1,
        metric: 'classSize', value: cls.lineCount, threshold: lineThreshold,
        suggestion: {
          type: 'Extract Class',
          description: `将 ${cls.name} 按职责拆分为多个类，每个类聚焦单一职责`,
          priority: cls.lineCount > lineThreshold * 1.5 ? 'high' : 'medium',
          effort: cls.members.methods.length > methodThreshold * 1.5 ? 'large' : 'medium',
          autoFixable: false,
        },
        endLine: cls.endLine,
      }));
    }
  }

  return smells;
}

export function detectLongParameterList(parsed: ParsedFile, config: RefactorConfig): CodeSmell[] {
  const smells: CodeSmell[] = [];

  for (const cls of parsed.classes) {
    for (const method of cls.members.methods) {
      const mLine = parsed.sourceFile.getLineAndCharacterOfPosition(method.node.getStart(parsed.sourceFile)).line + 1;
      checkParameterCount(parsed, config, smells, {
        container: `${cls.name}.${method.name}()`,
        paramCount: method.parameterCount,
        nodeLine: mLine,
      });
    }
  }

  for (const fn of parsed.functions) {
    checkParameterCount(parsed, config, smells, {
      container: `${fn.name}()`,
      paramCount: fn.parameterCount,
      nodeLine: fn.startLine,
    });
  }

  return smells;
}

function checkParameterCount(
  parsed: ParsedFile,
  config: RefactorConfig,
  smells: CodeSmell[],
  params: { container: string; paramCount: number; nodeLine: number },
): void {
  const threshold = config.thresholds.maxParameters;
  if (params.paramCount <= threshold) return;

  smells.push(makeSmell({
    ruleId: 'long-parameter-list',
    severity: config.severities['long-parameter-list'],
    message: `${params.container} 参数过多 (${params.paramCount} 个，阈值 ${threshold})，建议封装为参数对象`,
    filePath: parsed.filePath, line: params.nodeLine, column: 1,
    metric: 'parameterCount', value: params.paramCount, threshold,
    suggestion: {
      type: 'Introduce Parameter Object',
      description: `将 ${params.paramCount} 个参数封装为一个 interface/type 参数对象`,
      priority: params.paramCount > threshold * 1.5 ? 'high' : 'medium',
      effort: 'medium',
      autoFixable: false,
    },
  }));
}

export function detectOversizedFile(parsed: ParsedFile, config: RefactorConfig): CodeSmell[] {
  const smells: CodeSmell[] = [];
  const lineThreshold = config.thresholds.maxFileLines;
  const exportThreshold = config.thresholds.maxTopLevelExports;

  if (parsed.linesOfCode > lineThreshold || parsed.exports.length > exportThreshold) {
    const issues: string[] = [];
    if (parsed.linesOfCode > lineThreshold) {
      issues.push(`${parsed.linesOfCode} 行代码 (阈值 ${lineThreshold})`);
    }
    if (parsed.exports.length > exportThreshold) {
      issues.push(`${parsed.exports.length} 个顶层导出 (阈值 ${exportThreshold})`);
    }

    smells.push(makeSmell({
      ruleId: 'oversized-file',
      severity: 'warning',
      message: `文件过大 (${issues.join('，')})，建议按功能拆分`,
      filePath: parsed.filePath, line: 1, column: 1,
      metric: 'fileLines', value: parsed.linesOfCode, threshold: lineThreshold,
      suggestion: {
        type: 'Split File',
        description: `按功能领域将文件拆分为多个文件，每个文件聚焦单一职责`,
        priority: parsed.linesOfCode > lineThreshold * 1.5 ? 'high' : 'medium',
        effort: parsed.linesOfCode > lineThreshold * 2 ? 'large' : 'medium',
        autoFixable: false,
      },
    }));
  }

  return smells;
}

export function detectOversizedComponent(parsed: ParsedFile, config: RefactorConfig): CodeSmell[] {
  if (!isComponentFile(parsed.filePath)) return [];

  const metrics = measureComponentMetrics(parsed);
  if (!isOversizedComponent(parsed.linesOfCode, metrics.maxJsxDepth, metrics.handlerCount, config)) return [];

  const issues = collectComponentIssues(parsed.linesOfCode, metrics.maxJsxDepth, metrics.handlerCount, config);
  return [buildOversizedComponentSmell(parsed, issues, config)];
}

/** 统计组件规模指标：JSX 嵌套深度与事件处理函数数量 */
function measureComponentMetrics(parsed: ParsedFile): { maxJsxDepth: number; handlerCount: number } {
  const sourceText = parsed.sourceFile.getFullText();
  return {
    maxJsxDepth: computeJsxDepth(sourceText),
    handlerCount: countEventHandlers(sourceText),
  };
}

/** 构造组件过大代码异味 */
function buildOversizedComponentSmell(
  parsed: ParsedFile,
  issues: string[],
  config: RefactorConfig,
): CodeSmell {
  const lineThreshold = config.thresholds.maxComponentLines;
  return makeSmell({
    ruleId: 'oversized-component',
    severity: config.severities['oversized-component'],
    message: `组件过大 (${issues.join('，')})，建议拆分为子组件`,
    filePath: parsed.filePath, line: 1, column: 1,
    metric: 'componentLines', value: parsed.linesOfCode, threshold: lineThreshold,
    suggestion: {
      type: 'Extract Component / Custom Hook',
      description: `将 UI 部分拆分为子组件，将状态逻辑提取为自定义 Hook`,
      priority: parsed.linesOfCode > lineThreshold * 1.5 ? 'high' : 'medium',
      effort: parsed.linesOfCode > lineThreshold * 2 ? 'large' : 'medium',
      autoFixable: false,
    },
  });
}

function isComponentFile(filePath: string): boolean {
  return filePath.endsWith('.tsx') || filePath.endsWith('.jsx');
}

function countEventHandlers(sourceText: string): number {
  const handlerMatches = sourceText.match(/on(Click|Change|Submit|Focus|Blur|KeyDown|KeyUp|MouseEnter|MouseLeave)=/g);
  return handlerMatches ? handlerMatches.length : 0;
}

function isOversizedComponent(
  linesOfCode: number,
  maxJsxDepth: number,
  handlerCount: number,
  config: RefactorConfig,
): boolean {
  return linesOfCode > config.thresholds.maxComponentLines
    || maxJsxDepth > config.thresholds.maxJsxNestingDepth
    || handlerCount > config.thresholds.maxCallbackHandlers;
}

function collectComponentIssues(
  linesOfCode: number,
  maxJsxDepth: number,
  handlerCount: number,
  config: RefactorConfig,
): string[] {
  const issues: string[] = [];
  if (linesOfCode > config.thresholds.maxComponentLines) issues.push(`${linesOfCode} 行代码`);
  if (maxJsxDepth > config.thresholds.maxJsxNestingDepth) issues.push(`JSX 嵌套 ${maxJsxDepth} 层`);
  if (handlerCount > config.thresholds.maxCallbackHandlers) issues.push(`${handlerCount} 个事件处理函数`);
  return issues;
}

function computeJsxDepth(sourceText: string): number {
  let maxJsxDepth = 0;
  let currentDepth = 0;

  for (let i = 0; i < sourceText.length; i++) {
    const ch = sourceText[i];
    if (ch === '<' && i + 1 < sourceText.length && IDENT_START.test(sourceText[i + 1])) {
      currentDepth++;
      maxJsxDepth = Math.max(maxJsxDepth, currentDepth);
      continue;
    }
    if (ch === '/' && i + 1 < sourceText.length && sourceText[i + 1] === '>') {
      currentDepth = Math.max(0, currentDepth - 1);
      continue;
    }
    if (ch === '<' && i + 2 < sourceText.length && sourceText[i + 1] === '/') {
      currentDepth = Math.max(0, currentDepth - 1);
    }
  }
  return maxJsxDepth;
}
