import * as ts from 'typescript';

import type { ParsedFile, ParsedClass } from '../ast-helper';
import type { CodeSmell, RefactorConfig } from '../types';
import { makeSmell } from './adapter-types';

const IDENT_CHAR_PAREN = /[a-zA-Z0-9_$)]/;
const IDENT_CHAR = /[a-zA-Z0-9_$]/;
const IDENT_FULL = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;

export function detectInappropriateIntimacy(parsed: ParsedFile, config: RefactorConfig): CodeSmell[] {
  const smells: CodeSmell[] = [];

  for (const cls of parsed.classes) {
    const publicFields = isIntimacyCandidate(cls, parsed);
    if (!publicFields) continue;
    smells.push(buildIntimacySmell(cls, publicFields, parsed, config));
  }

  return smells;
}

/** 判断类是否为封装性违规候选：非框架托管、非测试夹具，返回其公共字段 */
function isIntimacyCandidate(
  cls: ParsedClass,
  parsed: ParsedFile,
): ParsedClass['members']['fields'] | null {
  // 跳过框架托管类（装饰器类）：TypeORM entity、class-validator DTO、Swagger
  // DTO 等依赖类或成员上装饰器的运行时元数据，改为 private 会破坏框架契约
  // （列映射、校验、OpenAPI 文档），它们是合理的数据载体而非封装性问题。
  if (isFrameworkManagedClass(cls.node)) return null;

  // 跳过测试 fixtures：刻意构造的样例代码，用于驱动规则测试，不是生产反模式。
  if (isTestFixture(parsed.filePath)) return null;

  const publicFields = cls.members.fields.filter(f => f.accessModifier === 'public');
  if (publicFields.length <= 3) return null;
  return publicFields;
}

/** 构造封装性违规代码异味 */
function buildIntimacySmell(
  cls: ParsedClass,
  publicFields: ParsedClass['members']['fields'],
  parsed: ParsedFile,
  config: RefactorConfig,
): CodeSmell {
  return makeSmell({
    ruleId: 'inappropriate-intimacy',
    severity: config.severities['inappropriate-intimacy'],
    message: `${cls.name} 暴露过多公共字段 (${publicFields.length} 个)，破坏封装性`,
    filePath: parsed.filePath, line: cls.startLine, column: 1,
    metric: 'publicFieldCount', value: publicFields.length, threshold: 3,
    suggestion: {
      type: 'Encapsulate Field',
      description: '将 public 字段改为 private，通过 getter/setter 访问',
      priority: 'high',
      effort: 'small',
      autoFixable: true,
    },
    endLine: cls.endLine,
  });
}

function isFrameworkManagedClass(node: ts.ClassDeclaration): boolean {
  const hasDecorators =
    (ts.canHaveDecorators(node) && (ts.getDecorators(node)?.length ?? 0) > 0) ||
    node.members.some(m => ts.canHaveDecorators(m) && (ts.getDecorators(m)?.length ?? 0) > 0);
  return hasDecorators;
}

function isTestFixture(filePath: string): boolean {
  return filePath.includes('/__tests__/') || filePath.includes('/fixtures/');
}

export function detectMiddleMan(parsed: ParsedFile, config: RefactorConfig): CodeSmell[] {
  const smells: CodeSmell[] = [];

  for (const cls of parsed.classes) {
    const stats = isMiddleManCandidate(cls, parsed);
    if (!stats) continue;
    smells.push(buildMiddleManSmell(cls, parsed, stats, config));
  }

  return smells;
}

/** 判断类是否为中间人候选：返回委托统计，不符合判定条件时返回 null */
function isMiddleManCandidate(
  cls: ParsedClass,
  parsed: ParsedFile,
): { delegatingMethods: number; totalMethods: number; delegationThreshold: number } | null {
  const totalMethods = cls.members.methods.length;
  // 与原有判定范围一致：仅对小类套用本规则；无方法类无意义
  if (totalMethods <= 0 || totalMethods > 5) return null;

  // 跳过框架托管类（装饰器类）：NestJS 服务/控制器等是框架要求的载体，
  // 其转发层不可移除，与 inappropriate-intimacy / lazy-class 的既有约定一致
  if (isFrameworkManagedClass(cls.node)) return null;

  const delegatingMethods = countDelegatingMethods(cls, parsed.sourceFile);

  // 仅当大部分方法（≥ 一半，且至少 2 个）是纯转发到协作者字段时才判定为中间人。
  // 旧实现对 fs./path./JSON./execFileAsync 等标准库与导入模块的调用计数，
  // 把"使用工具"误当成"委托"，导致大量误报；真正的委托签名是 this.<field>.<method>()。
  const delegationThreshold = Math.max(2, Math.ceil(totalMethods / 2));
  if (delegatingMethods < delegationThreshold) return null;
  return { delegatingMethods, totalMethods, delegationThreshold };
}

/** 构造中间人类代码异味 */
function buildMiddleManSmell(
  cls: ParsedClass,
  parsed: ParsedFile,
  stats: { delegatingMethods: number; totalMethods: number; delegationThreshold: number },
  config: RefactorConfig,
): CodeSmell {
  return makeSmell({
    ruleId: 'middle-man',
    severity: config.severities['middle-man'],
    message: `${cls.name} 大部分方法只是委托调用 (${stats.delegatingMethods} 次委托 / ${stats.totalMethods} 个方法)`,
    filePath: parsed.filePath, line: cls.startLine, column: 1,
    metric: 'delegationRatio', value: stats.delegatingMethods, threshold: stats.delegationThreshold,
    suggestion: {
      type: 'Remove Middle Man',
      description: '考虑移除中间层，让调用方直接使用委托目标',
      priority: 'low',
      effort: 'medium',
      autoFixable: false,
    },
    endLine: cls.endLine,
  });
}

function countDelegatingMethods(cls: ParsedClass, sourceFile: ts.SourceFile): number {
  const ownMethodNames = new Set(cls.members.methods.map(m => m.name));
  const collectionFields = collectCollectionFields(cls.node, sourceFile);
  let delegatingMethods = 0;

  for (const method of cls.members.methods) {
    if (isPureDelegationMethod(method.node, sourceFile, ownMethodNames, collectionFields)) {
      delegatingMethods++;
    }
  }
  return delegatingMethods;
}

/** 收集类中被当作数据容器的字段（Map/Set/Array 等），对其方法调用不算委托 */
function collectCollectionFields(cls: ts.ClassDeclaration, sourceFile: ts.SourceFile): Set<string> {
  const result = new Set<string>();
  const COLLECTION_TYPE = /^(Map|Set|Array|Record|WeakMap|WeakSet)\b/;

  for (const member of cls.members) {
    if (!ts.isPropertyDeclaration(member) || !member.name) continue;
    const fieldName = member.name.getText(sourceFile);

    const typeText = member.type?.getText(sourceFile) ?? '';
    if (COLLECTION_TYPE.test(typeText)) {
      result.add(fieldName);
      continue;
    }

    // 无类型标注时看初始化表达式 new Map(...) / new Set(...)
    if (member.initializer && ts.isNewExpression(member.initializer)) {
      const ctor = member.initializer.expression;
      if (ts.isIdentifier(ctor) && (ctor.text === 'Map' || ctor.text === 'Set')) {
        result.add(fieldName);
      }
    }
  }
  return result;
}

/**
 * 判定方法是否为纯委托方法：方法体只有一条语句，且该语句就是
 * 对协作者字段的调用（this.<field>.<method>(...) 或 return this.<field>.<method>(...)）。
 *
 * 只统计对实例字段的调用——这才是“中间人”模式的真实签名；对标准库/导入模块
 * （fs.、path.、JSON.、execFileAsync 等）的调用是工具使用，不属于委托。
 */
function isPureDelegationMethod(
  method: ts.MethodDeclaration,
  sourceFile: ts.SourceFile,
  ownMethodNames: Set<string>,
  collectionFields: Set<string>,
): boolean {
  const body = method.body;
  if (!body || !ts.isBlock(body)) return false;
  if (body.statements.length !== 1) return false;

  const stmt = body.statements[0];
  let expr: ts.Expression | undefined;
  if (ts.isReturnStatement(stmt)) {
    expr = stmt.expression;
  } else if (ts.isExpressionStatement(stmt)) {
    expr = stmt.expression;
  } else {
    return false;
  }
  if (!expr) return false;
  if (ts.isAwaitExpression(expr)) expr = expr.expression;
  if (!ts.isCallExpression(expr)) return false;

  // 调用目标必须形如 this.<field>.<method>
  const callee = expr.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  const receiver = callee.expression;
  if (!ts.isPropertyAccessExpression(receiver)) return false;
  if (receiver.expression.kind !== ts.SyntaxKind.ThisKeyword) return false;

  const fieldName = receiver.name.getText(sourceFile);
  // 排除 this.method() 这类对类自身方法的调用链，以及 Map/Set 等容器字段（包装集合是组合而非委托）
  return !ownMethodNames.has(fieldName) && !collectionFields.has(fieldName);
}

export function detectMessageChains(parsed: ParsedFile, config: RefactorConfig): CodeSmell[] {
  const smells: CodeSmell[] = [];

  for (const cls of parsed.classes) {
    for (const method of cls.members.methods) {
      const matches = extractMessageChains(method.node.getText(parsed.sourceFile));
      if (matches.length === 0) continue;

      const uniqueMatches = [...new Set(matches)].slice(0, 3);
      smells.push(makeSmell({
        ruleId: 'message-chains',
        severity: config.severities['message-chains'],
        message: `${cls.name}.${method.name}() 存在链式调用: ${uniqueMatches.join(', ')}`,
        filePath: parsed.filePath,
        line: parsed.sourceFile.getLineAndCharacterOfPosition(method.node.getStart(parsed.sourceFile)).line + 1,
        column: 1,
        metric: 'chainCount', value: uniqueMatches.length, threshold: 1,
        suggestion: {
          type: 'Hide Delegate',
          description: '将链式调用封装为委托方法，降低调用方与被调用方的耦合',
          priority: 'medium',
          effort: 'small',
          autoFixable: false,
        },
      }));
    }
  }

  return smells;
}

/** 提取方法文本中所有长度 ≥ 3 的链式调用片段 */
function extractMessageChains(methodText: string): string[] {
  const matches: string[] = [];
  let idx = 0;
  while (idx < methodText.length) {
    const dotIdx = methodText.indexOf('.', idx);
    if (dotIdx === -1) break;

    const chain = extractChainAtDot(methodText, dotIdx);
    if (chain) matches.push(chain);
    idx = dotIdx + 1;
  }
  return matches;
}

function extractChainAtDot(methodText: string, dotIdx: number): string | null {
  const { before, after } = readChainTokens(methodText, dotIdx);
  if (!isValidChainBoundary(before, after)) return null;

  const { length: chainLen, endIdx: searchIdx } = measureChainLength(methodText, dotIdx);
  if (chainLen < 3) return null;

  const chainEnd = Math.min(searchIdx + 30, methodText.length);
  return methodText.slice(dotIdx - 10, chainEnd).trim();
}

/** 读取点号两侧的标识符 token */
function readChainTokens(
  methodText: string,
  dotIdx: number,
): { before: string; after: string } {
  let start = dotIdx - 1;
  while (start >= 0 && IDENT_CHAR_PAREN.test(methodText[start])) start--;
  const before = methodText.slice(start + 1, dotIdx);

  let end = dotIdx + 1;
  while (end < methodText.length && IDENT_CHAR.test(methodText[end])) end++;
  const after = methodText.slice(dotIdx + 1, end);

  return { before, after };
}

/** 校验点号两侧是否为合法链式边界（排除 this. 与括号 / 花括号后缀） */
function isValidChainBoundary(before: string, after: string): boolean {
  return Boolean(before) && Boolean(after) && before !== 'this' && ![')', '}'].includes(before);
}

function measureChainLength(methodText: string, dotIdx: number): { length: number; endIdx: number } {
  let chainLen = 0;
  let searchIdx = dotIdx;
  while (searchIdx < methodText.length) {
    const nextDot = methodText.indexOf('.', searchIdx + 1);
    if (nextDot === -1) break;
    const between = methodText.slice(searchIdx + 1, nextDot);
    if (!IDENT_FULL.test(between.trim())) break;
    chainLen++;
    searchIdx = nextDot;
  }
  return { length: chainLen, endIdx: searchIdx };
}

export function detectRefusedBequest(parsed: ParsedFile, config: RefactorConfig): CodeSmell[] {
  const smells: CodeSmell[] = [];

  for (const cls of parsed.classes) {
    if (cls.extendsClass) {
      const ownMethods = cls.members.methods.filter(m => m.accessModifier === 'public').length;
      const ownFields = cls.members.fields.length;

      if (ownMethods <= 2 && ownFields <= 1) {
        smells.push(makeSmell({
          ruleId: 'refused-bequest',
          severity: config.severities['refused-bequest'],
          message: `${cls.name} 继承自 ${cls.extendsClass} 但几乎没有添加新成员 (${ownMethods} 方法, ${ownFields} 字段)，可能不需要继承`,
          filePath: parsed.filePath, line: cls.startLine, column: 1,
          metric: 'ownMethodCount', value: ownMethods, threshold: 3,
          suggestion: {
            type: 'Replace Inheritance with Delegation',
            description: `用组合 (Composition) 替换继承，减少继承层次`,
            priority: 'medium',
            effort: 'medium',
            autoFixable: false,
          },
          endLine: cls.endLine,
        }));
      }
    }
  }

  return smells;
}

export function detectLazyClass(parsed: ParsedFile, config: RefactorConfig): CodeSmell[] {
  const smells: CodeSmell[] = [];
  const threshold = config.thresholds.minClassLines;

  for (const cls of parsed.classes) {
    // 跳过框架托管类（装饰器类）与抽象基类：前者是框架要求的载体（NestJS
    // 模块/控制器/服务、class-validator DTO、React 组件等），内联会破坏框架
    // 契约；后者按设计小而薄，均不构成冗余类。
    const decorators = ts.canHaveDecorators(cls.node) ? ts.getDecorators(cls.node) : undefined;
    if (decorators && decorators.length > 0) continue;
    const modifiers = ts.canHaveModifiers(cls.node) ? ts.getModifiers(cls.node) : undefined;
    if (modifiers?.some(m => m.kind === ts.SyntaxKind.AbstractKeyword)) continue;

    if (cls.lineCount < threshold && cls.members.methods.length <= 2 && cls.members.fields.length <= 2) {
      smells.push(makeSmell({
        ruleId: 'lazy-class',
        severity: config.severities['lazy-class'],
        message: `${cls.name} 太小 (${cls.lineCount} 行，${cls.members.methods.length} 个方法)，可能不值得作为独立类`,
        filePath: parsed.filePath, line: cls.startLine, column: 1,
        metric: 'classLineCount', value: cls.lineCount, threshold,
        suggestion: {
          type: 'Inline Class',
          description: '将功能合并到调用它的类中，或直接移除',
          priority: 'low',
          effort: 'small',
          autoFixable: false,
        },
        endLine: cls.endLine,
      }));
    }
  }

  return smells;
}

export function detectSwitchStatement(parsed: ParsedFile, config: RefactorConfig): CodeSmell[] {
  const smells: CodeSmell[] = [];

  for (const cls of parsed.classes) {
    for (const method of cls.members.methods) {
      let switchCount = 0;
      function countSwitches(node: import('typescript').Node) {
        if (node.kind === ts.SyntaxKind.SwitchStatement) {
          switchCount++;
        }
        node.forEachChild(countSwitches);
      }
      countSwitches(method.node);

      if (switchCount > 0) {
        smells.push(makeSmell({
          ruleId: 'switch-statement',
          severity: config.severities['switch-statement'],
          message: `${cls.name}.${method.name}() 使用 ${switchCount} 处 switch 语句，建议用多态替代`,
          filePath: parsed.filePath,
          line: parsed.sourceFile.getLineAndCharacterOfPosition(method.node.getStart(parsed.sourceFile)).line + 1,
          column: 1,
          metric: 'switchCount', value: switchCount, threshold: 0,
          suggestion: {
            type: 'Replace Conditional with Polymorphism',
            description: '用策略模式或多态替换 switch/if-else if 链',
            priority: 'medium',
            effort: 'large',
            autoFixable: false,
          },
        }));
        break;
      }
    }
  }

  return smells;
}
