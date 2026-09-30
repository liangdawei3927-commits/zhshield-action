import * as ts from 'typescript';

import type { ParsedFile, ParsedClass } from '../ast-helper';
import type { CodeSmell, RefactorConfig } from '../types';
import { makeSmell } from './adapter-types';
import { extractMessageChains } from './chain-text-utils';

const COLLECTION_TYPE_RE = /^(Map|Set|Array|Record|WeakMap|WeakSet)\b/;

export function detectInappropriateIntimacy(
  parsed: ParsedFile,
  config: RefactorConfig,
): CodeSmell[] {
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
  if (isFrameworkManagedClass(cls.node)) return null;
  if (isTestFixture(parsed.filePath)) return null;
  return collectExcessivePublicFields(cls);
}

/** 收集超过 3 个的公共字段，未超过时返回 null */
function collectExcessivePublicFields(cls: ParsedClass): ParsedClass['members']['fields'] | null {
  const publicFields = cls.members.fields.filter((f) => f.accessModifier === 'public');
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
    filePath: parsed.filePath,
    line: cls.startLine,
    column: 1,
    metric: 'publicFieldCount',
    value: publicFields.length,
    threshold: 3,
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

/** 判断类是否为框架托管类（装饰器类）：TypeORM entity、class-validator DTO、Swagger DTO 等依赖类或成员上装饰器的运行时元数据，改为 private 会破坏框架契约（列映射、校验、OpenAPI 文档），它们是合理的数据载体而非封装性问题 */
function isFrameworkManagedClass(node: ts.ClassDeclaration): boolean {
  const hasDecorators =
    (ts.canHaveDecorators(node) && (ts.getDecorators(node)?.length ?? 0) > 0) ||
    node.members.some((m) => ts.canHaveDecorators(m) && (ts.getDecorators(m)?.length ?? 0) > 0);
  return hasDecorators;
}

/** 判断文件是否为测试 fixtures：刻意构造的样例代码，用于驱动规则测试，不是生产反模式 */
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
  if (!isSmallEnoughForDelegation(cls)) return null;
  if (isFrameworkManagedClass(cls.node)) return null;
  return computeDelegationStats(cls, parsed);
}

/** 仅对小类套用中间人规则：无方法类无意义 */
function isSmallEnoughForDelegation(cls: ParsedClass): boolean {
  const totalMethods = cls.members.methods.length;
  return totalMethods > 0 && totalMethods <= 5;
}

/** 统计委托方法数并计算判定阈值，未达阈值时返回 null。
 *  仅当大部分方法（≥ 一半，且至少 2 个）是纯转发到协作者字段时才判定为中间人；
 *  旧实现对 fs./path./JSON./execFileAsync 等标准库与导入模块的调用计数，把"使用工具"误当成"委托"，
 *  导致大量误报；真正的委托签名是 this.<field>.<method>()。 */
function computeDelegationStats(
  cls: ParsedClass,
  parsed: ParsedFile,
): { delegatingMethods: number; totalMethods: number; delegationThreshold: number } | null {
  const totalMethods = cls.members.methods.length;
  const delegatingMethods = countDelegatingMethods(cls, parsed.sourceFile);
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
    filePath: parsed.filePath,
    line: cls.startLine,
    column: 1,
    metric: 'delegationRatio',
    value: stats.delegatingMethods,
    threshold: stats.delegationThreshold,
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
  const ownMethodNames = new Set(cls.members.methods.map((m) => m.name));
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

  for (const member of cls.members) {
    if (!ts.isPropertyDeclaration(member) || !member.name) continue;
    const fieldName = member.name.getText(sourceFile);

    const typeText = member.type?.getText(sourceFile) ?? '';
    if (COLLECTION_TYPE_RE.test(typeText)) {
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
      smells.push(
        makeSmell({
          ruleId: 'message-chains',
          severity: config.severities['message-chains'],
          message: `${cls.name}.${method.name}() 存在链式调用: ${uniqueMatches.join(', ')}`,
          filePath: parsed.filePath,
          line:
            parsed.sourceFile.getLineAndCharacterOfPosition(method.node.getStart(parsed.sourceFile))
              .line + 1,
          column: 1,
          metric: 'chainCount',
          value: uniqueMatches.length,
          threshold: 1,
          suggestion: {
            type: 'Hide Delegate',
            description: '将链式调用封装为委托方法，降低调用方与被调用方的耦合',
            priority: 'medium',
            effort: 'small',
            autoFixable: false,
          },
        }),
      );
    }
  }

  return smells;
}

/** 语义豁免 refused-bequest：这些继承形态下「薄子类」是设计意图而非反模式——
 *  - extends Error：TS 里自定义错误必须子类化 Error 才能被 instanceof/catch 收窄，错误类天然没有新成员；
 *  - extends *Adapter：适配器按契约实现钩子（模板方法模式），子类薄是实现设计（提供策略而非添加成员）；
 *  - extends Component/PureComponent：React 类组件必须继承组件基类才能获得生命周期与状态能力；
 *  - 子类引用了继承成员（super.x() 或 this.<基类成员>）：遗产被实际使用，不是「拒绝遗产」。
 */
function isRefusedBequestExempt(cls: ParsedClass, sourceFile: ts.SourceFile): boolean {
  const base = cls.extendsClass ?? '';
  const baseName = base.replace(/<.*>/, '').trim(); // 剥掉泛型参数，如 Component<Props, State> → Component
  if (baseName === 'Error') return true;
  if (baseName === 'Component' || baseName === 'PureComponent') return true;
  if (baseName.endsWith('Adapter')) return true;
  return referencesInheritedMember(cls, sourceFile);
}

/** 判断子类是否引用了继承成员：super.x 调用，或 this.<成员> 指向未在本类声明的成员。
 *  引用了说明继承能力被实际使用——不是「只借了类型」。 */
function referencesInheritedMember(cls: ParsedClass, sourceFile: ts.SourceFile): boolean {
  const ownNames = new Set<string>();
  for (const m of cls.members.methods) ownNames.add(m.name);
  for (const f of cls.members.fields) ownNames.add(f.name);

  let found = false;
  function visit(node: ts.Node): void {
    if (found) return;
    if (ts.isPropertyAccessExpression(node)) {
      const expr = node.expression;
      if (expr.kind === ts.SyntaxKind.SuperKeyword) {
        found = true;
        return;
      }
      if (
        expr.kind === ts.SyntaxKind.ThisKeyword &&
        ts.isIdentifier(node.name) &&
        !ownNames.has(node.name.text)
      ) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(cls.node);
  return found;
}

export function detectRefusedBequest(parsed: ParsedFile, config: RefactorConfig): CodeSmell[] {
  const smells: CodeSmell[] = [];

  for (const cls of parsed.classes) {
    if (cls.extendsClass && !isRefusedBequestExempt(cls, parsed.sourceFile)) {
      const ownMethods = cls.members.methods.filter((m) => m.accessModifier === 'public').length;
      const ownFields = cls.members.fields.length;

      if (ownMethods <= 2 && ownFields <= 1) {
        smells.push(
          makeSmell({
            ruleId: 'refused-bequest',
            severity: config.severities['refused-bequest'],
            message: `${cls.name} 继承自 ${cls.extendsClass} 但几乎没有添加新成员 (${ownMethods} 方法, ${ownFields} 字段)，可能不需要继承`,
            filePath: parsed.filePath,
            line: cls.startLine,
            column: 1,
            metric: 'ownMethodCount',
            value: ownMethods,
            threshold: 3,
            suggestion: {
              type: 'Replace Inheritance with Delegation',
              description: `用组合 (Composition) 替换继承，减少继承层次`,
              priority: 'medium',
              effort: 'medium',
              autoFixable: false,
            },
            endLine: cls.endLine,
          }),
        );
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
    if (modifiers?.some((m) => m.kind === ts.SyntaxKind.AbstractKeyword)) continue;

    if (
      cls.lineCount < threshold &&
      cls.members.methods.length <= 2 &&
      cls.members.fields.length <= 2
    ) {
      smells.push(
        makeSmell({
          ruleId: 'lazy-class',
          severity: config.severities['lazy-class'],
          message: `${cls.name} 太小 (${cls.lineCount} 行，${cls.members.methods.length} 个方法)，可能不值得作为独立类`,
          filePath: parsed.filePath,
          line: cls.startLine,
          column: 1,
          metric: 'classLineCount',
          value: cls.lineCount,
          threshold,
          suggestion: {
            type: 'Inline Class',
            description: '将功能合并到调用它的类中，或直接移除',
            priority: 'low',
            effort: 'small',
            autoFixable: false,
          },
          endLine: cls.endLine,
        }),
      );
    }
  }

  return smells;
}

/** 判断 switch 是否为纯分发表：所有含语句的 case（含 default）都以 return/throw 结束。
 *  纯分发表是「以值分发的查表」形态，多态化只能得到等价的策略 Map，属于仪式性重写；
 *  真正值得用多态替代的是带共享可变状态、命令式语句的 switch（case 内修改外部变量、fall-through 累积状态等）。 */
function isPureDispatchSwitch(node: ts.SwitchStatement): boolean {
  for (const clause of node.caseBlock.clauses) {
    const stmts = clause.statements;
    if (stmts.length === 0) continue; // 空 case（fall-through 分组）无语句，不构成反模式
    const last = stmts[stmts.length - 1];
    if (!ts.isReturnStatement(last) && !ts.isThrowStatement(last)) return false;
  }
  return true;
}

export function detectSwitchStatement(parsed: ParsedFile, config: RefactorConfig): CodeSmell[] {
  const smells: CodeSmell[] = [];

  for (const cls of parsed.classes) {
    for (const method of cls.members.methods) {
      let switchCount = 0;
      function countSwitches(node: import('typescript').Node) {
        // 纯分发表（每个非空 case 以 return/throw 结束）是构造器，不是反模式：
        // 多态化只是把 switch 换成等价的策略分发表，属于仪式性重写
        if (
          node.kind === ts.SyntaxKind.SwitchStatement &&
          !isPureDispatchSwitch(node as ts.SwitchStatement)
        ) {
          switchCount++;
        }
        node.forEachChild(countSwitches);
      }
      countSwitches(method.node);

      if (switchCount > 0) {
        smells.push(
          makeSmell({
            ruleId: 'switch-statement',
            severity: config.severities['switch-statement'],
            message: `${cls.name}.${method.name}() 使用 ${switchCount} 处 switch 语句，建议用多态替代`,
            filePath: parsed.filePath,
            line:
              parsed.sourceFile.getLineAndCharacterOfPosition(
                method.node.getStart(parsed.sourceFile),
              ).line + 1,
            column: 1,
            metric: 'switchCount',
            value: switchCount,
            threshold: 0,
            suggestion: {
              type: 'Replace Conditional with Polymorphism',
              description: '用策略模式或多态替换 switch/if-else if 链',
              priority: 'medium',
              effort: 'large',
              autoFixable: false,
            },
          }),
        );
        break;
      }
    }
  }

  return smells;
}
