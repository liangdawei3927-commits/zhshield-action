import type { ParsedFile } from '../ast-helper';
import type { CodeSmell, RefactorConfig } from '../types';
import { makeSmell } from './adapter-types';
import * as ts from 'typescript';

export function detectLongMethod(parsed: ParsedFile, config: RefactorConfig): CodeSmell[] {
  const smells: CodeSmell[] = [];

  for (const cls of parsed.classes) {
    for (const method of cls.members.methods) {
      checkLongMethod(parsed, config, smells, {
        name: `${cls.name}.${method.name}()`,
        container: `${cls.name}.`,
        lineCount: method.lineCount,
        complexity: method.complexity,
        nodeLine: method.node.getStart
          ? parsed.sourceFile.getLineAndCharacterOfPosition(method.node.getStart(parsed.sourceFile))
              .line + 1
          : cls.startLine,
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
  params: {
    name: string;
    container: string;
    lineCount: number;
    complexity: number;
    nodeLine: number;
  },
): void {
  const threshold = config.thresholds.maxMethodLines;
  const complexityThreshold = config.thresholds.maxComplexity;
  if (params.lineCount <= threshold && params.complexity <= complexityThreshold) return;

  const parts: string[] = [];
  if (params.lineCount > threshold) parts.push(`${params.lineCount} 行 (阈值 ${threshold})`);
  if (params.complexity > complexityThreshold)
    parts.push(`圈复杂度 ${params.complexity} (阈值 ${complexityThreshold})`);

  smells.push(
    makeSmell({
      ruleId: 'long-method',
      severity: config.severities['long-method'],
      message: `${params.container}${params.name} 过大 (${parts.join('，')})，建议拆分为更小的函数`,
      filePath: parsed.filePath,
      line: params.nodeLine,
      column: 1,
      metric: 'methodLineCount',
      value: Math.max(params.lineCount, params.complexity),
      threshold: Math.max(threshold, complexityThreshold),
      suggestion: {
        type: 'Extract Method',
        description: `将 ${params.container}${params.name} 按职责拆分为多个小函数，每个不超过 ${threshold} 行`,
        priority: params.lineCount > threshold * 1.5 ? 'high' : 'medium',
        effort: params.lineCount > threshold * 2 ? 'large' : 'small',
        autoFixable: false,
      },
    }),
  );
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

      smells.push(
        makeSmell({
          ruleId: 'large-class',
          severity: config.severities['large-class'],
          message: `${cls.name} 过大 (${issues.join('，')})，建议按职责拆分`,
          filePath: parsed.filePath,
          line: cls.startLine,
          column: 1,
          metric: 'classSize',
          value: cls.lineCount,
          threshold: lineThreshold,
          suggestion: {
            type: 'Extract Class',
            description: `将 ${cls.name} 按职责拆分为多个类，每个类聚焦单一职责`,
            priority: cls.lineCount > lineThreshold * 1.5 ? 'high' : 'medium',
            effort: cls.members.methods.length > methodThreshold * 1.5 ? 'large' : 'medium',
            autoFixable: false,
          },
          endLine: cls.endLine,
        }),
      );
    }
  }

  return smells;
}

export function detectLongParameterList(parsed: ParsedFile, config: RefactorConfig): CodeSmell[] {
  const smells: CodeSmell[] = [];

  for (const cls of parsed.classes) {
    for (const method of cls.members.methods) {
      const mLine =
        parsed.sourceFile.getLineAndCharacterOfPosition(method.node.getStart(parsed.sourceFile))
          .line + 1;
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

  smells.push(
    makeSmell({
      ruleId: 'long-parameter-list',
      severity: config.severities['long-parameter-list'],
      message: `${params.container} 参数过多 (${params.paramCount} 个，阈值 ${threshold})，建议封装为参数对象`,
      filePath: parsed.filePath,
      line: params.nodeLine,
      column: 1,
      metric: 'parameterCount',
      value: params.paramCount,
      threshold,
      suggestion: {
        type: 'Introduce Parameter Object',
        description: `将 ${params.paramCount} 个参数封装为一个 interface/type 参数对象`,
        priority: params.paramCount > threshold * 1.5 ? 'high' : 'medium',
        effort: 'medium',
        autoFixable: false,
      },
    }),
  );
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

    smells.push(
      makeSmell({
        ruleId: 'oversized-file',
        severity: 'warning',
        message: `文件过大 (${issues.join('，')})，建议按功能拆分`,
        filePath: parsed.filePath,
        line: 1,
        column: 1,
        metric: 'fileLines',
        value: parsed.linesOfCode,
        threshold: lineThreshold,
        suggestion: {
          type: 'Split File',
          description: `按功能领域将文件拆分为多个文件，每个文件聚焦单一职责`,
          priority: parsed.linesOfCode > lineThreshold * 1.5 ? 'high' : 'medium',
          effort: parsed.linesOfCode > lineThreshold * 2 ? 'large' : 'medium',
          autoFixable: false,
        },
      }),
    );
  }

  return smells;
}

export function detectOversizedComponent(parsed: ParsedFile, config: RefactorConfig): CodeSmell[] {
  if (!isComponentFile(parsed.filePath)) return [];

  const worst = findWorstComponent(parsed.sourceFile);
  if (!worst) return [];

  const issues = collectComponentIssues(worst, config);
  if (issues.length === 0) return [];

  return [buildOversizedComponentSmell(parsed, worst, issues, config)];
}

interface ComponentSize {
  name: string;
  startLine: number;
  endLine: number;
  linesOfCode: number;
  maxJsxDepth: number;
  handlerCount: number;
}

function findWorstComponent(sourceFile: ts.SourceFile): ComponentSize | null {
  const components: ComponentSize[] = [];

  const addComponent = (name: string, node: ts.Node): void => {
    const startLine = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    const endLine = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
    components.push({
      name,
      startLine,
      endLine,
      linesOfCode: countLinesOfCode(node.getText(sourceFile)),
      maxJsxDepth: computeJsxDepthFromAst(node),
      handlerCount: countEventHandlers(node.getText(sourceFile)),
    });
  };

  const visit = (node: ts.Node): void => {
    const name = componentNameOf(node, sourceFile);
    if (name !== null) {
      addComponent(name, node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  if (components.length === 0) return null;
  components.sort(
    (a, b) =>
      b.linesOfCode - a.linesOfCode || b.maxJsxDepth - a.maxJsxDepth || b.handlerCount - a.handlerCount,
  );
  return components[0];
}

/**
 * 识别 React 组件形态并返回组件名：
 * - 大写开头的函数声明；
 * - 大写变量（initializer 为箭头函数/函数表达式，或 memo/forwardRef 调用）；
 * - 继承自 (Pure)Component 的类声明。
 * 非组件节点返回 null。
 */
function componentNameOf(node: ts.Node, sourceFile: ts.SourceFile): string | null {
  if (ts.isFunctionDeclaration(node) && node.name && /^[A-Z]/.test(node.name.text)) {
    return node.name.text;
  }
  if (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    /^[A-Z]/.test(node.name.text)
  ) {
    const initializer = node.initializer;
    if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) {
      return node.name.text;
    }
    if (
      initializer &&
      ts.isCallExpression(initializer) &&
      ts.isIdentifier(initializer.expression) &&
      (initializer.expression.text === 'memo' || initializer.expression.text === 'forwardRef')
    ) {
      return node.name.text;
    }
    return null;
  }
  if (
    ts.isClassDeclaration(node) &&
    node.name &&
    /^[A-Z]/.test(node.name.text) &&
    (node.heritageClauses ?? []).some((clause) =>
      clause.types.some((t) =>
        /(?:React\.)?(?:Pure)?Component$/.test(t.expression.getText(sourceFile)),
      ),
    )
  ) {
    return node.name.text;
  }
  return null;
}

function countLinesOfCode(text: string): number {
  return text
    .split('\n')
    .filter(
      (line) =>
        line.trim().length > 0 &&
        !line.trim().startsWith('//') &&
        !line.trim().startsWith('/*') &&
        !line.trim().startsWith('*'),
    ).length;
}

/**
 * 基于真实 AST 计算 JSX 嵌套深度：JSX 元素的深度 = 其 JSX 祖先元素数 + 1。
 *
 * 遍历时必须在参数中传递「当前 JSX 祖先数」，而不是共享可变计数器——
 * 共享计数器会在兄弟子树之间泄漏（后续兄弟的 JSX 元素在上一个子树的深度上
 * 继续 +1），把 2-3 层的真实嵌套虚报成几十上百层（如 dependency-parts.tsx
 * 报 184 层、真实仅 9 层）。
 *
 * 只统计真正的 JSX 元素（JsxElement / JsxSelfClosingElement）的父链深度，
 * TS 泛型 / SVG / 字符串中的尖括号不参与。
 */
function computeJsxDepthFromAst(node: ts.Node): number {
  let maxJsxDepth = 0;
  function visit(n: ts.Node, jsxAncestors: number): void {
    const next = ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) ? jsxAncestors + 1 : jsxAncestors;
    if (next > maxJsxDepth) maxJsxDepth = next;
    ts.forEachChild(n, (child) => visit(child, next));
  }
  visit(node, 0);
  return maxJsxDepth;
}

function buildOversizedComponentSmell(
  parsed: ParsedFile,
  component: ComponentSize,
  issues: string[],
  config: RefactorConfig,
): CodeSmell {
  const lineThreshold = config.thresholds.maxComponentLines;
  return makeSmell({
    ruleId: 'oversized-component',
    severity: config.severities['oversized-component'],
    message: `组件 ${component.name} 过大 (${issues.join('，')})，建议拆分为子组件`,
    filePath: parsed.filePath,
    line: component.startLine,
    column: 1,
    metric: 'componentLines',
    value: component.linesOfCode,
    threshold: lineThreshold,
    suggestion: {
      type: 'Extract Component / Custom Hook',
      description: `将 ${component.name} 按职责拆分为子组件，将状态逻辑提取为自定义 Hook`,
      priority: component.linesOfCode > lineThreshold * 1.5 ? 'high' : 'medium',
      effort: component.linesOfCode > lineThreshold * 2 ? 'large' : 'medium',
      autoFixable: false,
    },
    endLine: component.endLine,
  });
}

function isComponentFile(filePath: string): boolean {
  return filePath.endsWith('.tsx') || filePath.endsWith('.jsx');
}

function countEventHandlers(sourceText: string): number {
  const handlerMatches = sourceText.match(
    /on(Click|Change|Submit|Focus|Blur|KeyDown|KeyUp|MouseEnter|MouseLeave)=/g,
  );
  return handlerMatches ? handlerMatches.length : 0;
}

function collectComponentIssues(component: ComponentSize, config: RefactorConfig): string[] {
  const issues: string[] = [];
  if (component.linesOfCode > config.thresholds.maxComponentLines)
    issues.push(`${component.linesOfCode} 行代码`);
  if (component.maxJsxDepth > config.thresholds.maxJsxNestingDepth)
    issues.push(`JSX 嵌套 ${component.maxJsxDepth} 层`);
  if (component.handlerCount > config.thresholds.maxCallbackHandlers)
    issues.push(`${component.handlerCount} 个事件处理函数`);
  return issues;
}

