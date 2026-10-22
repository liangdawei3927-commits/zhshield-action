import * as ts from 'typescript';

import type { ParsedFile, ParsedClass } from '../ast-helper';
import { collectExternalCalls } from '../ast-helper';
import type { CodeSmell, RefactorConfig } from '../types';
import { makeSmell } from './adapter-types';

type ParsedMethod = ParsedClass['members']['methods'][number];

const UPPER_CASE_START = /^[A-Z0-9_]/;

/** 统计方法的外部调用占比 */
function computeExternalCallRatio(
  parsed: ParsedFile,
  cls: ParsedClass,
  method: ParsedClass['members']['methods'][number],
): { externalCount: number; totalStatements: number; ratio: number } {
  const externalCalls = collectExternalCalls(method.node, cls.name, parsed.sourceFile);
  const externalCount =
    externalCalls.size === 0 ? 0 : [...externalCalls.values()].reduce((a, b) => a + b, 0);
  const totalStatements = method.lineCount;
  const ratio = totalStatements > 0 ? externalCount / totalStatements : 0;
  return { externalCount, totalStatements, ratio };
}

/** 找出被调用最多的外部目标 */
function findTopTarget(externalCalls: Map<string, number>): string {
  const sortedEntries = [...externalCalls.entries()].sort((a, b) => b[1] - a[1]);
  const topTarget = sortedEntries.length > 0 ? sortedEntries[0] : null;
  return topTarget ? topTarget[0] : '外部类';
}

/** 分析单个方法是否构成 Feature Envy，是则生成 CodeSmell */
function analyzeMethodForFeatureEnvy(
  parsed: ParsedFile,
  cls: ParsedClass,
  method: ParsedClass['members']['methods'][number],
  config: RefactorConfig,
): CodeSmell | null {
  const externalCalls = collectExternalCalls(method.node, cls.name, parsed.sourceFile);
  if (externalCalls.size === 0) return null;

  const stats = computeExternalCallRatio(parsed, cls, method);
  if (stats.ratio <= config.thresholds.featureEnvyRatio || stats.externalCount <= 3) return null;

  const targetName = findTopTarget(externalCalls);
  return buildFeatureEnvySmell({ parsed, cls, method, config, stats, targetName });
}

interface BuildFeatureEnvySmellParams {
  parsed: ParsedFile;
  cls: ParsedClass;
  method: ParsedClass['members']['methods'][number];
  config: RefactorConfig;
  stats: { externalCount: number; totalStatements: number; ratio: number };
  targetName: string;
}

/** 构造 Feature Envy CodeSmell */
function buildFeatureEnvySmell(params: BuildFeatureEnvySmellParams): CodeSmell {
  const { parsed, cls, method, config, stats, targetName } = params;
  const threshold = config.thresholds.featureEnvyRatio;
  return makeSmell({
    ruleId: 'feature-envy',
    severity: config.severities['feature-envy'],
    message: `${cls.name}.${method.name}() 大量调用 ${targetName} (${stats.externalCount} 次外部引用 vs ${stats.totalStatements} 行代码)`,
    filePath: parsed.filePath,
    line:
      parsed.sourceFile.getLineAndCharacterOfPosition(method.node.getStart(parsed.sourceFile))
        .line + 1,
    column: 1,
    metric: 'externalCallRatio',
    value: Math.round(stats.ratio * 100),
    threshold: Math.round(threshold * 100),
    suggestion: {
      type: 'Move Method',
      description: `考虑将 ${method.name}() 移到 ${targetName.split('.')[0]} 类中`,
      priority: 'medium',
      effort: 'medium',
      autoFixable: false,
    },
  });
}

export function detectFeatureEnvy(parsed: ParsedFile, config: RefactorConfig): CodeSmell[] {
  const smells: CodeSmell[] = [];

  for (const cls of parsed.classes) {
    for (const method of cls.members.methods) {
      const smell = analyzeMethodForFeatureEnvy(parsed, cls, method, config);
      if (smell) smells.push(smell);
    }
  }

  return smells;
}

export function detectShotgunSurgery(
  parsed: ParsedFile,
  allFiles: ParsedFile[],
  config: RefactorConfig,
): CodeSmell[] {
  const smells: CodeSmell[] = [];

  detectExcessivePublicMethods(parsed, config, smells);
  detectSharedStringLiterals(parsed, collectRepeatedStringLiterals(allFiles), smells);

  return smells;
}

function detectExcessivePublicMethods(
  parsed: ParsedFile,
  config: RefactorConfig,
  smells: CodeSmell[],
): void {
  for (const cls of parsed.classes) {
    const publicMethods = cls.members.methods.filter((m) => m.accessModifier === 'public');
    if (publicMethods.length <= 10) continue;

    smells.push(
      makeSmell({
        ruleId: 'shotgun-surgery',
        severity: config.severities['shotgun-surgery'],
        message: `${cls.name} 有 ${publicMethods.length} 个公共方法，修改某个功能可能需要改动多个方法`,
        filePath: parsed.filePath,
        line: cls.startLine,
        column: 1,
        metric: 'publicMethodCount',
        value: publicMethods.length,
        threshold: 10,
        suggestion: {
          type: 'Extract Class / Consolidate Responsibility',
          description: '按职责将类拆分为更小的类，减少修改波及范围',
          priority: 'medium',
          effort: 'large',
          autoFixable: false,
        },
        endLine: cls.endLine,
      }),
    );
  }
}

/** 跨文件收集大写开头字符串字面量及其出现文件集合 */
function collectRepeatedStringLiterals(allFiles: ParsedFile[]): Map<string, Set<string>> {
  const stringLiterals = new Map<string, Set<string>>();
  for (const otherFile of allFiles) {
    const text = otherFile.sourceFile.getFullText();
    const strings = text.match(/"([^"]{3,})"/g);
    if (!strings) continue;

    for (const s of strings) {
      const cleaned = s.slice(1, -1);
      if (!UPPER_CASE_START.test(cleaned) || cleaned.includes(' ')) continue;
      let files = stringLiterals.get(cleaned);
      if (!files) {
        files = new Set();
        stringLiterals.set(cleaned, files);
      }
      files.add(otherFile.filePath);
    }
  }
  return stringLiterals;
}

function detectSharedStringLiterals(
  parsed: ParsedFile,
  stringLiterals: Map<string, Set<string>>,
  smells: CodeSmell[],
): void {
  for (const [literal, files] of stringLiterals) {
    if (files.size <= 3 || !files.has(parsed.filePath)) continue;

    smells.push(
      makeSmell({
        ruleId: 'shotgun-surgery',
        severity: 'info',
        message: `字符串 "${literal}" 在 ${files.size} 个文件中出现，建议提取为共享常量`,
        filePath: parsed.filePath,
        line: 1,
        column: 1,
        metric: 'hardcodedStrings',
        value: files.size,
        threshold: 3,
        suggestion: {
          type: 'Extract Constant',
          description: `将 "${literal}" 提取为共享常量文件，集中管理一处修改`,
          priority: 'low',
          effort: 'small',
          autoFixable: true,
        },
      }),
    );
    break;
  }
}

export function detectGodObject(parsed: ParsedFile, config: RefactorConfig): CodeSmell[] {
  const smells: CodeSmell[] = [];
  const methodThreshold = config.thresholds.maxGodObjectMethods;

  for (const cls of parsed.classes) {
    const publicMethodCount = cls.members.methods.filter(
      (m) => m.accessModifier === 'public',
    ).length;

    if (publicMethodCount > methodThreshold) {
      smells.push(
        makeSmell({
          ruleId: 'god-object',
          severity: config.severities['god-object'],
          message: `${cls.name} 有 ${publicMethodCount} 个公共方法 (阈值 ${methodThreshold})，可能是上帝对象`,
          filePath: parsed.filePath,
          line: cls.startLine,
          column: 1,
          metric: 'publicMethodCount',
          value: publicMethodCount,
          threshold: methodThreshold,
          suggestion: {
            type: 'Split God Class',
            description: `将 ${cls.name} 按领域拆分为多个专注的 Service/Class`,
            priority: publicMethodCount > methodThreshold * 1.5 ? 'high' : 'medium',
            effort: publicMethodCount > methodThreshold * 1.5 ? 'large' : 'medium',
            autoFixable: false,
          },
          endLine: cls.endLine,
        }),
      );
    }
  }

  return smells;
}

/** data-clumps 语义豁免 1：框架注入装饰器白名单（NestJS 路由/DI 契约常用集）。
 *  只认注入语义的装饰器——@Injectable/@Get 等类/方法级装饰器不在其列，
 *  避免"带任意装饰器即豁免"的过宽口径。 */
const FRAMEWORK_INJECTION_DECORATORS = new Set([
  'Param',
  'Body',
  'Res',
  'Req',
  'Query',
  'Headers',
  'Session',
]);

/** 取装饰器表达式最左侧的标识符名：@Param('id') → Param，@a.b.C() → a（保底兜底用全文本判断前先归一） */
function decoratorBaseName(decorator: ts.Decorator): string {
  let expr: ts.Expression = decorator.expression;
  while (ts.isCallExpression(expr) || ts.isPropertyAccessExpression(expr)) {
    expr = expr.expression;
  }
  return ts.isIdentifier(expr) ? expr.text : '';
}

/** data-clumps 语义豁免 1：框架注入签名。
 *  NestJS 等框架的路由/DI 处理器签名由装饰器契约决定，参数必须各自独立装饰、
 *  不可封装，属必要结构而非数据泥团。仅当【每个】参数都至少携带一个注入类
 *  装饰器（Param/Body/Res/Req/Query/Headers/Session）才豁免；零参数方法与
 *  存在未装饰参数的方法一律不豁免（后者可能是真泥团，见 mixed 签名回归用例）。 */
function isFrameworkInjectionSignature(params: readonly ts.ParameterDeclaration[]): boolean {
  if (params.length === 0) return false; // 零参数方法不参与豁免
  return params.every((p) => {
    const decorators = ts.canHaveDecorators(p) ? ts.getDecorators(p) : undefined;
    if (!decorators || decorators.length === 0) return false;
    return decorators.some((d) => FRAMEWORK_INJECTION_DECORATORS.has(decoratorBaseName(d)));
  });
}

/** data-clumps 语义豁免 2：单行同参转发的委托别名。
 *  单行同参转发的委托别名（如 verifyPackageWithKey → verifyPackage，@deprecated
 *  兼容别名）签名必须镜像主方法，重复属刻意设计而非数据泥团。
 *  判定必须同时满足：方法体恰好一条语句、该语句为 return、表达式为函数调用、
 *  实参个数 === 形参个数、被调用者为 this.<name> 或 <标识符>.<name> 属性访问——
 *  任一条件不满足（如多语句实现、参数被改写、本地计算后返回）都不豁免。 */
function isPureDelegatingAlias(method: ParsedMethod): boolean {
  const body = method.node.body;
  if (!body || body.statements.length !== 1) return false;

  const statement = body.statements[0];
  if (!ts.isReturnStatement(statement) || !statement.expression) return false;

  const expr = statement.expression;
  if (!ts.isCallExpression(expr)) return false;
  if (expr.arguments.length !== method.node.parameters.length) return false;

  const callee = expr.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  const target = callee.expression;
  return target.kind === ts.SyntaxKind.ThisKeyword || ts.isIdentifier(target);
}

/** 收集重复出现的参数组合（以类型序列为键）。
 *  参数类型文本保持 string[] 直到消息渲染，禁止 join(',').split(',') 往返：
 *  含逗号的泛型（Record<string, unknown>）会被切碎，消息丢参数并出现双空格。 */
function collectParamGroups(
  parsed: ParsedFile,
): Map<string, { methods: string[]; params: string[] }> {
  const paramGroups = new Map<string, { methods: string[]; params: string[] }>();

  for (const cls of parsed.classes) {
    for (const method of cls.members.methods) {
      const params = method.node.parameters;
      if (params.length < 3) continue;
      if (isFrameworkInjectionSignature(params)) continue;
      if (isPureDelegatingAlias(method)) continue;

      const paramTypes = params.map((p) => (p.type ? p.type.getText(parsed.sourceFile) : 'any'));
      const groupKey = paramTypes.join(',');
      let group = paramGroups.get(groupKey);
      if (!group) {
        group = { methods: [], params: paramTypes };
        paramGroups.set(groupKey, group);
      }
      group.methods.push(`${cls.name}.${method.name}`);
    }
  }

  return paramGroups;
}

/** 构造数据泥团 CodeSmell */
function buildDataClumpSmell(
  parsed: ParsedFile,
  group: { methods: string[]; params: string[] },
  config: RefactorConfig,
): CodeSmell {
  const sampleMethods = group.methods.slice(0, 3);
  return makeSmell({
    ruleId: 'data-clumps',
    severity: config.severities['data-clumps'],
    message: `参数组合 [${group.params.slice(0, 3).join(', ')}] 反复出现 (${group.methods.length} 次): ${sampleMethods.join(', ')}...`,
    filePath: parsed.filePath,
    line: 1,
    column: 1,
    metric: 'clumpFrequency',
    value: group.methods.length,
    threshold: 2,
    suggestion: {
      type: 'Extract Class / Parameter Object',
      description: '将重复出现的参数组合封装为一个类',
      priority: 'low',
      effort: 'medium',
      autoFixable: false,
    },
  });
}

export function detectDataClumps(parsed: ParsedFile, config: RefactorConfig): CodeSmell[] {
  const smells: CodeSmell[] = [];

  const paramGroups = collectParamGroups(parsed);

  for (const [, group] of paramGroups) {
    if (group.methods.length >= 3) {
      smells.push(buildDataClumpSmell(parsed, group, config));
    }
  }

  return smells;
}

const PRIMITIVE_TYPES = new Set(['string', 'number', 'boolean', 'any', 'void']);
const PRIMITIVE_FIELD_THRESHOLD = 5;

export function detectPrimitiveObsession(parsed: ParsedFile, config: RefactorConfig): CodeSmell[] {
  const smells: CodeSmell[] = [];
  const primitiveCounts = collectPrimitiveFieldCounts(parsed);

  for (const [className, count] of primitiveCounts) {
    if (count > PRIMITIVE_FIELD_THRESHOLD) {
      smells.push(
        makeSmell({
          ruleId: 'primitive-obsession',
          severity: config.severities['primitive-obsession'],
          message: `${className} 使用过多原始类型 (${count} 个字段)，建议为相关字段创建值对象`,
          filePath: parsed.filePath,
          line: 1,
          column: 1,
          metric: 'primitiveFieldCount',
          value: count,
          threshold: PRIMITIVE_FIELD_THRESHOLD,
          suggestion: {
            type: 'Replace Primitive with Object',
            description: '将相关原始类型字段封装为值对象（Value Object）',
            priority: 'low',
            effort: 'medium',
            autoFixable: false,
          },
        }),
      );
    }
  }

  return smells;
}

function collectPrimitiveFieldCounts(parsed: ParsedFile): Map<string, number> {
  const primitiveCounts = new Map<string, number>();

  for (const cls of parsed.classes) {
    let count = 0;
    for (const field of cls.members.fields) {
      if (PRIMITIVE_TYPES.has(field.type)) {
        count++;
      }
    }
    if (count > 0) {
      primitiveCounts.set(cls.name, count);
    }
  }

  return primitiveCounts;
}
