import { translate, DEFAULT_LANGUAGE, type LanguageCode } from '@zh/i18n';
import type { ParsedFile } from '../ast-helper';
import type { CodeSmell, RefactorConfig } from '../types';
import { makeSmell } from './adapter-types';

const IDENT_START = /[a-zA-Z_]/;
/** `<` 前一字符为标识符字符时，它属于 TS 泛型/类型参数（Pick<T>、Bounce<T extends ...>）而非 JSX 开标签 */
const PREV_IS_IDENT = /[a-zA-Z0-9_$.]/;

export function detectLongMethod(parsed: ParsedFile, config: RefactorConfig, locale?: LanguageCode): CodeSmell[] {
  const tr = (key: string, params?: Record<string, unknown>) => translate(key, locale ?? DEFAULT_LANGUAGE, params);
  const smells: CodeSmell[] = [];

  for (const cls of parsed.classes) {
    for (const method of cls.members.methods) {
      checkLongMethod(parsed, config, smells, tr, {
        name: `${cls.name}.${method.name}()`,
        container: `${cls.name}.`,
        lineCount: method.lineCount,
        complexity: method.complexity,
        nodeLine: method.node.getStart ? parsed.sourceFile.getLineAndCharacterOfPosition(method.node.getStart(parsed.sourceFile)).line + 1 : cls.startLine,
      });
    }
  }

  for (const fn of parsed.functions) {
    checkLongMethod(parsed, config, smells, tr, {
      name: `${fn.name}()`,
      container: '',
      lineCount: fn.lineCount,
      complexity: fn.complexity,
      nodeLine: fn.startLine,
    });
  }

  return smells;
}

type TranslateFn = (key: string, params?: Record<string, unknown>) => string;

function checkLongMethod(
  parsed: ParsedFile,
  config: RefactorConfig,
  smells: CodeSmell[],
  tr: TranslateFn,
  params: { name: string; container: string; lineCount: number; complexity: number; nodeLine: number },
): void {
  const threshold = config.thresholds.maxMethodLines;
  const complexityThreshold = config.thresholds.maxComplexity;
  if (params.lineCount <= threshold && params.complexity <= complexityThreshold) return;

  const parts: string[] = [];
  if (params.lineCount > threshold) parts.push(tr('engine.refactor.smell.long-method.issue.lines', { lines: params.lineCount, threshold }));
  if (params.complexity > complexityThreshold) parts.push(tr('engine.refactor.smell.long-method.issue.complexity', { complexity: params.complexity, threshold: complexityThreshold }));

  smells.push(makeSmell({
    ruleId: 'long-method',
    severity: config.severities['long-method'],
    message: tr('engine.refactor.smell.long-method.message', { container: params.container, name: params.name, issues: parts.join('，') }),
    filePath: parsed.filePath, line: params.nodeLine, column: 1,
    metric: 'methodLineCount', value: Math.max(params.lineCount, params.complexity), threshold: Math.max(threshold, complexityThreshold),
    suggestion: {
      type: 'Extract Method',
      description: tr('engine.refactor.smell.long-method.suggestion', { container: params.container, name: params.name, threshold }),
      priority: params.lineCount > threshold * 1.5 ? 'high' : 'medium',
      effort: params.lineCount > threshold * 2 ? 'large' : 'small',
      autoFixable: false,
    },
  }));
}

export function detectLargeClass(parsed: ParsedFile, config: RefactorConfig, locale?: LanguageCode): CodeSmell[] {
  const tr = (key: string, params?: Record<string, unknown>) => translate(key, locale ?? DEFAULT_LANGUAGE, params);
  const smells: CodeSmell[] = [];
  const lineThreshold = config.thresholds.maxClassLines;
  const methodThreshold = config.thresholds.maxClassMethods;

  for (const cls of parsed.classes) {
    if (cls.lineCount > lineThreshold || cls.members.methods.length > methodThreshold) {
      const issues: string[] = [];
      if (cls.lineCount > lineThreshold) issues.push(tr('engine.refactor.smell.large-class.issue.lines', { lines: cls.lineCount, threshold: lineThreshold }));
      if (cls.members.methods.length > methodThreshold) {
        issues.push(tr('engine.refactor.smell.large-class.issue.methods', { methods: cls.members.methods.length, threshold: methodThreshold }));
      }

      smells.push(makeSmell({
        ruleId: 'large-class',
        severity: config.severities['large-class'],
        message: tr('engine.refactor.smell.large-class.message', { className: cls.name, issues: issues.join('，') }),
        filePath: parsed.filePath, line: cls.startLine, column: 1,
        metric: 'classSize', value: cls.lineCount, threshold: lineThreshold,
        suggestion: {
          type: 'Extract Class',
          description: tr('engine.refactor.smell.large-class.suggestion', { className: cls.name }),
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

export function detectLongParameterList(parsed: ParsedFile, config: RefactorConfig, locale?: LanguageCode): CodeSmell[] {
  const tr = (key: string, params?: Record<string, unknown>) => translate(key, locale ?? DEFAULT_LANGUAGE, params);
  const smells: CodeSmell[] = [];

  for (const cls of parsed.classes) {
    for (const method of cls.members.methods) {
      const mLine = parsed.sourceFile.getLineAndCharacterOfPosition(method.node.getStart(parsed.sourceFile)).line + 1;
      checkParameterCount(parsed, config, smells, tr, {
        container: `${cls.name}.${method.name}()`,
        paramCount: method.parameterCount,
        nodeLine: mLine,
      });
    }
  }

  for (const fn of parsed.functions) {
    checkParameterCount(parsed, config, smells, tr, {
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
  tr: TranslateFn,
  params: { container: string; paramCount: number; nodeLine: number },
): void {
  const threshold = config.thresholds.maxParameters;
  if (params.paramCount <= threshold) return;

  smells.push(makeSmell({
    ruleId: 'long-parameter-list',
    severity: config.severities['long-parameter-list'],
    message: tr('engine.refactor.smell.long-parameter-list.message', { container: params.container, count: params.paramCount, threshold }),
    filePath: parsed.filePath, line: params.nodeLine, column: 1,
    metric: 'parameterCount', value: params.paramCount, threshold,
    suggestion: {
      type: 'Introduce Parameter Object',
      description: tr('engine.refactor.smell.long-parameter-list.suggestion', { count: params.paramCount }),
      priority: params.paramCount > threshold * 1.5 ? 'high' : 'medium',
      effort: 'medium',
      autoFixable: false,
    },
  }));
}

export function detectOversizedFile(parsed: ParsedFile, config: RefactorConfig, locale?: LanguageCode): CodeSmell[] {
  const tr = (key: string, params?: Record<string, unknown>) => translate(key, locale ?? DEFAULT_LANGUAGE, params);
  const smells: CodeSmell[] = [];
  const lineThreshold = config.thresholds.maxFileLines;
  const exportThreshold = config.thresholds.maxTopLevelExports;

  if (parsed.linesOfCode > lineThreshold || parsed.exports.length > exportThreshold) {
    const issues: string[] = [];
    if (parsed.linesOfCode > lineThreshold) {
      issues.push(tr('engine.refactor.smell.oversized-file.issue.linesCode', { lines: parsed.linesOfCode, threshold: lineThreshold }));
    }
    if (parsed.exports.length > exportThreshold) {
      issues.push(tr('engine.refactor.smell.oversized-file.issue.exports', { exports: parsed.exports.length, threshold: exportThreshold }));
    }

    smells.push(makeSmell({
      ruleId: 'oversized-file',
      severity: 'warning',
      message: tr('engine.refactor.smell.oversized-file.message', { issues: issues.join('，') }),
      filePath: parsed.filePath, line: 1, column: 1,
      metric: 'fileLines', value: parsed.linesOfCode, threshold: lineThreshold,
      suggestion: {
        type: 'Split File',
        description: tr('engine.refactor.smell.oversized-file.suggestion'),
        priority: parsed.linesOfCode > lineThreshold * 1.5 ? 'high' : 'medium',
        effort: parsed.linesOfCode > lineThreshold * 2 ? 'large' : 'medium',
        autoFixable: false,
      },
    }));
  }

  return smells;
}

export function detectOversizedComponent(parsed: ParsedFile, config: RefactorConfig, locale?: LanguageCode): CodeSmell[] {
  if (!isComponentFile(parsed.filePath)) return [];

  const metrics = measureComponentMetrics(parsed);
  if (!isOversizedComponent(parsed.linesOfCode, metrics.maxJsxDepth, metrics.handlerCount, config)) return [];

  const issues = collectComponentIssues(parsed.linesOfCode, metrics.maxJsxDepth, metrics.handlerCount, config, locale);
  return [buildOversizedComponentSmell(parsed, issues, config, locale)];
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
  locale?: LanguageCode,
): CodeSmell {
  const lineThreshold = config.thresholds.maxComponentLines;
  return makeSmell({
    ruleId: 'oversized-component',
    severity: config.severities['oversized-component'],
    message: translate('engine.refactor.smell.oversized-component.message', locale ?? DEFAULT_LANGUAGE, { issues: issues.join('，') }),
    filePath: parsed.filePath, line: 1, column: 1,
    metric: 'componentLines', value: parsed.linesOfCode, threshold: lineThreshold,
    suggestion: {
      type: 'Extract Component / Custom Hook',
      description: translate('engine.refactor.smell.oversized-component.suggestion', locale ?? DEFAULT_LANGUAGE),
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
  locale?: LanguageCode,
): string[] {
  const issues: string[] = [];
  if (linesOfCode > config.thresholds.maxComponentLines) {
    issues.push(translate('engine.refactor.smell.oversized-component.issue.lines', locale ?? DEFAULT_LANGUAGE, { lines: linesOfCode }));
  }
  if (maxJsxDepth > config.thresholds.maxJsxNestingDepth) {
    issues.push(translate('engine.refactor.smell.oversized-component.issue.jsxDepth', locale ?? DEFAULT_LANGUAGE, { depth: maxJsxDepth }));
  }
  if (handlerCount > config.thresholds.maxCallbackHandlers) {
    issues.push(translate('engine.refactor.smell.oversized-component.issue.handlers', locale ?? DEFAULT_LANGUAGE, { handlers: handlerCount }));
  }
  return issues;
}

function computeJsxDepth(sourceText: string): number {
  let maxJsxDepth = 0;
  let currentDepth = 0;

  for (let i = 0; i < sourceText.length; i++) {
    const ch = sourceText[i];
    if (ch === '<' && i + 1 < sourceText.length && IDENT_START.test(sourceText[i + 1])) {
      // 泛型/类型参数里的 `<`（Pick<T>、Bounce<T extends ...>）前一字符是标识符，不算 JSX 开标签
      const prevIsIdent = i > 0 && PREV_IS_IDENT.test(sourceText[i - 1]);
      if (!prevIsIdent) {
        currentDepth++;
        maxJsxDepth = Math.max(maxJsxDepth, currentDepth);
      }
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
