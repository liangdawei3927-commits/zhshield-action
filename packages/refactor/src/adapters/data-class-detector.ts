import * as ts from 'typescript';

import type { ParsedFile, ParsedClass } from '../ast-helper';
import type { CodeSmell, RefactorConfig } from '../types';
import { makeSmell } from './adapter-types';
import { isFrameworkManagedClass, isTestFixture } from './detector-heuristics';

/** 判断类是否为纯数据类候选：非框架托管、非测试夹具、字段多方法少 */
function isDataClassCandidate(
  parsed: ParsedFile,
  cls: ParsedClass,
  config: RefactorConfig,
): boolean {
  if (isFrameworkManagedClass(cls.node)) return false;
  if (isTestFixture(parsed.filePath)) return false;
  return isFieldHeavyMethodLight(cls, config);
}

/** 字段数达标、方法数不超限且方法均无实质行为时判定为数据类 */
function isFieldHeavyMethodLight(cls: ParsedClass, config: RefactorConfig): boolean {
  const ownMethods = countNonTrivialMethods(cls);
  const fieldCount = cls.members.fields.length;
  if (fieldCount < config.thresholds.minDataClassFields) return false;
  if (ownMethods > config.thresholds.maxDataClassMethods) return false;
  // 字段多方法少只是数据类的必要条件：若仅有的方法承载实质行为（操作自身字段/含控制流），
  // 该类已承担行为职责（如依赖注入的策略/服务对象），并非纯数据类，排除此类误报。
  return !hasSubstantiveBehavior(cls);
}

interface BuildDataClassSmellParams {
  parsed: ParsedFile;
  cls: ParsedClass;
  fieldCount: number;
  ownMethods: number;
  config: RefactorConfig;
}

/** 构造数据类 CodeSmell */
function buildDataClassSmell(params: BuildDataClassSmellParams): CodeSmell {
  const { parsed, cls, fieldCount, ownMethods, config } = params;
  return makeSmell({
    ruleId: 'data-class',
    severity: config.severities['data-class'],
    message: `${cls.name} 有 ${fieldCount} 个字段但只有 ${ownMethods} 个方法，可能是纯数据类`,
    filePath: parsed.filePath,
    line: cls.startLine,
    column: 1,
    metric: 'fieldMethodRatio',
    value: fieldCount,
    threshold: ownMethods,
    suggestion: {
      type: 'Move Method to Data Class',
      description: `将操作 ${cls.name} 字段的方法搬移到类中，或将其转为 TypeScript interface`,
      priority: 'medium',
      effort: 'medium',
      autoFixable: false,
    },
    endLine: cls.endLine,
  });
}

/** 数据类检测（R10）：字段多、方法少且方法均无实质行为的类，建议转为 interface 或内聚行为 */
export function detectDataClass(parsed: ParsedFile, config: RefactorConfig): CodeSmell[] {
  const smells: CodeSmell[] = [];

  for (const cls of parsed.classes) {
    if (!isDataClassCandidate(parsed, cls, config)) continue;

    const ownMethods = countNonTrivialMethods(cls);
    const fieldCount = cls.members.fields.length;
    smells.push(buildDataClassSmell({ parsed, cls, fieldCount, ownMethods, config }));
  }

  return smells;
}

/** 不构成类行为的方法名：构造与序列化出口 */
const NON_BEHAVIOR_METHOD_NAMES = new Set(['constructor', 'toString', 'toJSON']);

function countNonTrivialMethods(cls: ParsedClass): number {
  return cls.members.methods.filter((m) => !NON_BEHAVIOR_METHOD_NAMES.has(m.name)).length;
}

/** 类是否含实质行为方法：平凡访问器之外的方法即构成行为 */
function hasSubstantiveBehavior(cls: ParsedClass): boolean {
  return cls.members.methods
    .filter((m) => !NON_BEHAVIOR_METHOD_NAMES.has(m.name))
    .some((m) => !isTrivialAccessor(m.node));
}

/** 方法是否为平凡访问器：无方法体（抽象/重载签名），或方法体仅一条 `return this.x;` / `this.x = ...;` */
function isTrivialAccessor(method: ts.MethodDeclaration): boolean {
  const body = method.body;
  if (!body) return true;
  if (body.statements.length !== 1) return false;
  const statement = body.statements[0];
  if (ts.isReturnStatement(statement)) {
    return statement.expression !== undefined && isSelfFieldAccess(statement.expression);
  }
  if (ts.isExpressionStatement(statement)) {
    return isSelfFieldAssignment(statement.expression);
  }
  return false;
}

/** 表达式是否为 `this.<field>` 只读访问 */
function isSelfFieldAccess(expr: ts.Expression): boolean {
  return ts.isPropertyAccessExpression(expr) && expr.expression.kind === ts.SyntaxKind.ThisKeyword;
}

/** 表达式是否为 `this.<field> = <expr>` 赋值 */
function isSelfFieldAssignment(expr: ts.Expression): boolean {
  return (
    ts.isBinaryExpression(expr) &&
    expr.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    isSelfFieldAccess(expr.left)
  );
}
