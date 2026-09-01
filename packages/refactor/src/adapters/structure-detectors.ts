import type { ParsedFile } from '../ast-helper';
import { computeNestingDepth, findDuplicateCodeBlocks } from '../ast-helper';
import type { CodeSmell, RefactorConfig } from '../types';
import { makeSmell } from './adapter-types';

const BLANK_LINE_BLOCK = /\n\s*\n/;

export function detectDeepNesting(parsed: ParsedFile, config: RefactorConfig): CodeSmell[] {
  const smells: CodeSmell[] = [];
  const threshold = config.thresholds.maxNestingDepth;

  for (const cls of parsed.classes) {
    for (const method of cls.members.methods) {
      const depth = computeNestingDepth(method.node);
      if (depth > threshold) {
        const sm = makeSmell({
          ruleId: 'deep-nesting',
          severity: config.severities['deep-nesting'],
          message: `${cls.name}.${method.name}() 嵌套过深 (${depth} 层，阈值 ${threshold})，建议使用 guard clause 或提取方法`,
          filePath: parsed.filePath,
          line:
            parsed.sourceFile.getLineAndCharacterOfPosition(method.node.getStart(parsed.sourceFile))
              .line + 1,
          column: 1,
          metric: 'nestingDepth',
          value: depth,
          threshold,
          suggestion: {
            type: 'Flatten / Early Return',
            description: `使用 guard clause 提前返回，或将深层分支提取为独立函数`,
            priority: depth > threshold * 1.5 ? 'high' : 'medium',
            effort: 'small',
            autoFixable: false,
          },
        });
        smells.push(sm);
      }
    }
  }

  for (const fn of parsed.functions) {
    const depth = computeNestingDepth(fn.node);
    if (depth > threshold) {
      smells.push(
        makeSmell({
          ruleId: 'deep-nesting',
          severity: config.severities['deep-nesting'],
          message: `${fn.name}() 嵌套过深 (${depth} 层)`,
          filePath: parsed.filePath,
          line: fn.startLine,
          column: 1,
          metric: 'nestingDepth',
          value: depth,
          threshold,
          suggestion: {
            type: 'Flatten / Early Return',
            description: '使用 guard clause 提前返回，或将深层分支提取为独立函数',
            priority: depth > threshold * 1.5 ? 'high' : 'medium',
            effort: 'small',
            autoFixable: false,
          },
        }),
      );
    }
  }

  return smells;
}

export function detectMixedResponsibilities(
  parsed: ParsedFile,
  config: RefactorConfig,
): CodeSmell[] {
  const smells: CodeSmell[] = [];
  const threshold = config.thresholds.minResponsibilities;

  for (const cls of parsed.classes) {
    for (const method of cls.members.methods) {
      const source = method.node.getText(parsed.sourceFile);
      const responsibilityCount = countResponsibilities(source);

      if (responsibilityCount > threshold) {
        smells.push(
          makeSmell({
            ruleId: 'mixed-responsibilities',
            severity: config.severities['mixed-responsibilities'],
            message: `${cls.name}.${method.name}() 混合了约 ${responsibilityCount} 个职责 (阈值 ${threshold})，建议拆分为独立函数`,
            filePath: parsed.filePath,
            line:
              parsed.sourceFile.getLineAndCharacterOfPosition(
                method.node.getStart(parsed.sourceFile),
              ).line + 1,
            column: 1,
            metric: 'responsibilityCount',
            value: responsibilityCount,
            threshold,
            suggestion: {
              type: 'Extract Function per Responsibility',
              description: `按注释分区 / 空行分隔 / try/catch 边界将方法拆分为多个独立函数`,
              priority: responsibilityCount > threshold + 2 ? 'high' : 'medium',
              effort: responsibilityCount > threshold + 3 ? 'large' : 'medium',
              autoFixable: false,
            },
          }),
        );
      }
    }
  }

  for (const fn of parsed.functions) {
    const source = fn.node.getText(parsed.sourceFile);
    const responsibilityCount = countResponsibilities(source);
    if (responsibilityCount > threshold) {
      smells.push(
        makeSmell({
          ruleId: 'mixed-responsibilities',
          severity: config.severities['mixed-responsibilities'],
          message: `${fn.name}() 混合了约 ${responsibilityCount} 个职责`,
          filePath: parsed.filePath,
          line: fn.startLine,
          column: 1,
          metric: 'responsibilityCount',
          value: responsibilityCount,
          threshold,
          suggestion: {
            type: 'Extract Function per Responsibility',
            description: '按职责将函数拆分为多个独立函数',
            priority: responsibilityCount > threshold + 2 ? 'high' : 'medium',
            effort: responsibilityCount > threshold + 3 ? 'large' : 'medium',
            autoFixable: false,
          },
        }),
      );
    }
  }

  return smells;
}

function countResponsibilities(source: string): number {
  let count = 0;
  count += countCommentSections(source);
  count += countBlankLineBlocks(source);
  count += countTryCatchBlocks(source);

  if (count === 0 && source.split('\n').length > 40) {
    count = 1;
  }

  return count;
}

/** 按注释分区（分隔线 / 步骤编号 / 冒号标注 / 大写开头）计数 */
function countCommentSections(source: string): number {
  const commentSections = source.match(
    /\/\/\s*[-=_]{3,}|\/\/\s*步骤\s*\d+|\/\/\s*.+?[:：]|(\/\/\s*[A-Z][a-zA-Z])/g,
  );
  return commentSections ? commentSections.length : 0;
}

/** 按空行分隔的代码块计数（超过 2 块才累计） */
function countBlankLineBlocks(source: string): number {
  const blankLineBlocks = source.split(BLANK_LINE_BLOCK).filter((b) => b.trim().length > 20).length;
  return blankLineBlocks > 2 ? Math.max(0, blankLineBlocks - 1) : 0;
}

function countTryCatchBlocks(source: string): number {
  const tryCatchBlocks = source.match(/try\s*{/g);
  return tryCatchBlocks ? tryCatchBlocks.length : 0;
}

let _dupCache: ReturnType<typeof findDuplicateCodeBlocks> | null = null;
let _dupCacheFiles: ParsedFile[] | null = null;
let _dupCacheMinLines: number = 0;

export function detectDuplicateCode(
  parsed: ParsedFile,
  allFiles: ParsedFile[],
  config: RefactorConfig,
): CodeSmell[] {
  const smells: CodeSmell[] = [];
  const minLines = config.thresholds.minDuplicateLines;

  if (_dupCache === null || _dupCacheFiles !== allFiles || _dupCacheMinLines !== minLines) {
    _dupCache = findDuplicateCodeBlocks(allFiles, minLines);
    _dupCacheFiles = allFiles;
    _dupCacheMinLines = minLines;
  }
  const duplicates = _dupCache;
  const fileDups = duplicates.filter(
    (d) => d.files[0] === parsed.filePath || d.files[1] === parsed.filePath,
  );

  for (const dup of fileDups) {
    const otherFile = dup.files[0] === parsed.filePath ? dup.files[1] : dup.files[0];

    smells.push(
      makeSmell({
        ruleId: 'duplicated-code',
        severity: config.severities['duplicated-code'],
        message: `代码块与 ${otherFile}:${dup.lines[1]} 重复，建议提取为公共函数`,
        filePath: parsed.filePath,
        line: dup.lines[0],
        column: 1,
        metric: 'duplicateLines',
        value: dup.code.length,
        threshold: minLines,
        suggestion: {
          type: 'Extract Common Function',
          description: `将重复代码提取为公共函数，通过参数化差异点统一调用`,
          priority: 'medium',
          effort: 'medium',
          autoFixable: false,
        },
        endLine: dup.lines[0] + minLines,
      }),
    );
  }

  return smells;
}

export function detectCallbackHell(parsed: ParsedFile, config: RefactorConfig): CodeSmell[] {
  const smells: CodeSmell[] = [];

  for (const cls of parsed.classes) {
    for (const method of cls.members.methods) {
      const methodText = method.node.getText(parsed.sourceFile);
      const chainCount = (methodText.match(/\.then\(/g) || []).length;

      if (chainCount > 3) {
        smells.push(
          makeSmell({
            ruleId: 'callback-hell',
            severity: config.severities['callback-hell'],
            message: `${cls.name}.${method.name}() 包含 ${chainCount} 层 .then() 链式回调，建议转换为 async/await`,
            filePath: parsed.filePath,
            line:
              parsed.sourceFile.getLineAndCharacterOfPosition(
                method.node.getStart(parsed.sourceFile),
              ).line + 1,
            column: 1,
            metric: 'thenChainCount',
            value: chainCount,
            threshold: 3,
            suggestion: {
              type: 'Convert to Async/Await',
              description: '将 .then() 链式回调转换为 async/await 语法，保留 try/catch 错误处理',
              priority: chainCount > 5 ? 'high' : 'medium',
              effort: 'small',
              autoFixable: true,
            },
          }),
        );
      }
    }
  }

  return smells;
}
