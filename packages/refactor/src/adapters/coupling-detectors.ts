import * as ts from 'typescript';

import type { ParsedFile, ParsedClass } from '../ast-helper';
import { collectExternalCalls } from '../ast-helper';
import type { CodeSmell, RefactorConfig } from '../types';
import { makeSmell } from './adapter-types';

const UPPER_CASE_START = /^[A-Z0-9_]/;

/** 统计方法的外部调用占比 */
function computeExternalCallRatio(
  parsed: ParsedFile,
  cls: ParsedClass,
  method: ParsedClass['members']['methods'][number],
): { externalCount: number; totalStatements: number; ratio: number } {
  const externalCalls = collectExternalCalls(method.node, cls.name, parsed.sourceFile);
  const externalCount = externalCalls.size === 0 ? 0 : [...externalCalls.values()].reduce((a, b) => a + b, 0);
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
  return buildFeatureEnvySmell(parsed, cls, method, config, stats, targetName);
}

/** 构造 Feature Envy CodeSmell */
function buildFeatureEnvySmell(
  parsed: ParsedFile,
  cls: ParsedClass,
  method: ParsedClass['members']['methods'][number],
  config: RefactorConfig,
  stats: { externalCount: number; totalStatements: number; ratio: number },
  targetName: string,
): CodeSmell {
  const threshold = config.thresholds.featureEnvyRatio;
  return makeSmell({
    ruleId: 'feature-envy',
    severity: config.severities['feature-envy'],
    message: `${cls.name}.${method.name}() 大量调用 ${targetName} (${stats.externalCount} 次外部引用 vs ${stats.totalStatements} 行代码)`,
    filePath: parsed.filePath,
    line: parsed.sourceFile.getLineAndCharacterOfPosition(method.node.getStart(parsed.sourceFile)).line + 1,
    column: 1,
    metric: 'externalCallRatio', value: Math.round(stats.ratio * 100), threshold: Math.round(threshold * 100),
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

export function detectShotgunSurgery(parsed: ParsedFile, allFiles: ParsedFile[], config: RefactorConfig): CodeSmell[] {
  const smells: CodeSmell[] = [];

  detectExcessivePublicMethods(parsed, config, smells);
  detectSharedStringLiterals(parsed, collectRepeatedStringLiterals(allFiles), smells);

  return smells;
}

function detectExcessivePublicMethods(parsed: ParsedFile, config: RefactorConfig, smells: CodeSmell[]): void {
  for (const cls of parsed.classes) {
    const publicMethods = cls.members.methods.filter(m => m.accessModifier === 'public');
    if (publicMethods.length <= 10) continue;

    smells.push(makeSmell({
      ruleId: 'shotgun-surgery',
      severity: config.severities['shotgun-surgery'],
      message: `${cls.name} 有 ${publicMethods.length} 个公共方法，修改某个功能可能需要改动多个方法`,
      filePath: parsed.filePath, line: cls.startLine, column: 1,
      metric: 'publicMethodCount', value: publicMethods.length, threshold: 10,
      suggestion: {
        type: 'Extract Class / Consolidate Responsibility',
        description: '按职责将类拆分为更小的类，减少修改波及范围',
        priority: 'medium',
        effort: 'large',
        autoFixable: false,
      },
      endLine: cls.endLine,
    }));
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
      if (!stringLiterals.has(cleaned)) stringLiterals.set(cleaned, new Set());
      stringLiterals.get(cleaned)!.add(otherFile.filePath);
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

    smells.push(makeSmell({
      ruleId: 'shotgun-surgery',
      severity: 'info',
      message: `字符串 "${literal}" 在 ${files.size} 个文件中出现，建议提取为共享常量`,
      filePath: parsed.filePath, line: 1, column: 1,
      metric: 'hardcodedStrings', value: files.size, threshold: 3,
      suggestion: {
        type: 'Extract Constant',
        description: `将 "${literal}" 提取为共享常量文件，集中管理一处修改`,
        priority: 'low',
        effort: 'small',
        autoFixable: true,
      },
    }));
    break;
  }
}

/** 判断类是否为纯数据类候选：非框架托管、非测试夹具、字段多方法少 */
function isDataClassCandidate(parsed: ParsedFile, cls: ParsedClass, config: RefactorConfig): boolean {
  if (isFrameworkManagedClass(cls.node)) return false;
  if (isTestFixture(parsed.filePath)) return false;
  return isFieldHeavyMethodLight(cls, config);
}

/** 字段数达标且方法数不超限时判定为数据类 */
function isFieldHeavyMethodLight(cls: ParsedClass, config: RefactorConfig): boolean {
  const ownMethods = countNonTrivialMethods(cls);
  const fieldCount = cls.members.fields.length;
  return fieldCount >= config.thresholds.minDataClassFields && ownMethods <= config.thresholds.maxDataClassMethods;
}

/** 构造数据类 CodeSmell */
function buildDataClassSmell(
  parsed: ParsedFile,
  cls: ParsedClass,
  fieldCount: number,
  ownMethods: number,
  config: RefactorConfig,
): CodeSmell {
  return makeSmell({
    ruleId: 'data-class',
    severity: config.severities['data-class'],
    message: `${cls.name} 有 ${fieldCount} 个字段但只有 ${ownMethods} 个方法，可能是纯数据类`,
    filePath: parsed.filePath, line: cls.startLine, column: 1,
    metric: 'fieldMethodRatio', value: fieldCount, threshold: ownMethods,
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

export function detectDataClass(parsed: ParsedFile, config: RefactorConfig): CodeSmell[] {
  const smells: CodeSmell[] = [];

  for (const cls of parsed.classes) {
    if (!isDataClassCandidate(parsed, cls, config)) continue;

    const ownMethods = countNonTrivialMethods(cls);
    const fieldCount = cls.members.fields.length;
    smells.push(buildDataClassSmell(parsed, cls, fieldCount, ownMethods, config));
  }

  return smells;
}

/** 判断类是否为框架托管类（装饰器类）：TypeORM entity、class-validator DTO、Swagger DTO 等依赖类或成员装饰器的运行时元数据，转 interface 或内联方法会破坏框架契约，它们是合理的数据载体而非纯数据类反模式 */
function isFrameworkManagedClass(node: ts.ClassDeclaration): boolean {
  const classDecorators = ts.canHaveDecorators(node) ? ts.getDecorators(node) : undefined;
  const hasMemberDecorators = node.members.some(m => {
    if (!ts.canHaveDecorators(m)) return false;
    const decorators = ts.getDecorators(m);
    return decorators !== undefined && decorators.length > 0;
  });
  return (classDecorators && classDecorators.length > 0) || hasMemberDecorators;
}

/** 判断文件是否为测试 fixtures：刻意构造的样例代码，用于驱动规则测试，不是生产反模式 */
function isTestFixture(filePath: string): boolean {
  return filePath.includes('/__tests__/') || filePath.includes('/fixtures/');
}

function countNonTrivialMethods(cls: ParsedClass): number {
  return cls.members.methods.filter(m =>
    m.name !== 'constructor' && m.name !== 'toString' && m.name !== 'toJSON'
  ).length;
}

export function detectGodObject(parsed: ParsedFile, config: RefactorConfig): CodeSmell[] {
  const smells: CodeSmell[] = [];
  const methodThreshold = config.thresholds.maxGodObjectMethods;

  for (const cls of parsed.classes) {
    const publicMethodCount = cls.members.methods.filter(m => m.accessModifier === 'public').length;

    if (publicMethodCount > methodThreshold) {
      smells.push(makeSmell({
        ruleId: 'god-object',
        severity: config.severities['god-object'],
        message: `${cls.name} 有 ${publicMethodCount} 个公共方法 (阈值 ${methodThreshold})，可能是上帝对象`,
        filePath: parsed.filePath, line: cls.startLine, column: 1,
        metric: 'publicMethodCount', value: publicMethodCount, threshold: methodThreshold,
        suggestion: {
          type: 'Split God Class',
          description: `将 ${cls.name} 按领域拆分为多个专注的 Service/Class`,
          priority: publicMethodCount > methodThreshold * 1.5 ? 'high' : 'medium',
          effort: publicMethodCount > methodThreshold * 1.5 ? 'large' : 'medium',
          autoFixable: false,
        },
        endLine: cls.endLine,
      }));
    }
  }

  return smells;
}

/** 收集重复出现的参数组合（以类型序列为键） */
function collectParamGroups(parsed: ParsedFile): Map<string, { methods: string[]; params: string[] }> {
  const paramGroups = new Map<string, { methods: string[]; params: string[] }>();

  for (const cls of parsed.classes) {
    for (const method of cls.members.methods) {
      const params = method.node.parameters;
      if (params.length < 3) continue;

      const paramTypes = params.map(p => {
        if (p.type) return p.type.getText(parsed.sourceFile);
        return 'any';
      }).join(',');
      if (!paramGroups.has(paramTypes)) {
        paramGroups.set(paramTypes, { methods: [], params: paramTypes.split(',') });
      }
      paramGroups.get(paramTypes)!.methods.push(`${cls.name}.${method.name}`);
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
    filePath: parsed.filePath, line: 1, column: 1,
    metric: 'clumpFrequency', value: group.methods.length, threshold: 2,
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
      smells.push(makeSmell({
        ruleId: 'primitive-obsession',
        severity: config.severities['primitive-obsession'],
        message: `${className} 使用过多原始类型 (${count} 个字段)，建议为相关字段创建值对象`,
        filePath: parsed.filePath, line: 1, column: 1,
        metric: 'primitiveFieldCount', value: count, threshold: PRIMITIVE_FIELD_THRESHOLD,
        suggestion: {
          type: 'Replace Primitive with Object',
          description: '将相关原始类型字段封装为值对象（Value Object）',
          priority: 'low',
          effort: 'medium',
          autoFixable: false,
        },
      }));
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
