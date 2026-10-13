import * as ts from 'typescript';
import * as fs from 'fs';

// ---------------------------------------------------------------------------
// RE_* 正则常量：全部提升到模块作用域（module scope）。
// 这些正则原先内联在函数体内，每次函数调用都会重新编译一次字面量；
// 提升为模块级 const 后只在模块加载时编译一次，随后复用同一实例。
// pattern 文本、flags 与 test/replace 语义均与原内联写法完全一致。
// ---------------------------------------------------------------------------

// —— 重复块收集（collectCodeBlocks）——
/** 归一化文本中是否含至少一个标识符字符（字母/数字/_/$，忽略大小写） */
const RE_HAS_IDENTIFIER = /[a-z0-9_$]/i;

// —— import 语句识别（isImportStatementLine）——
/** `import ... from '...'` 声明行 */
const RE_IMPORT_FROM = /^import\s+.*from\s+['"]/;
/** `import {` / `import type {` / `import (` 开头的具名或默认导入列表行 */
const RE_IMPORT_LIST_START = /^import\s+(?:type\s+)?[({]/;
/** `export ... from '...'` 再导出声明行 */
const RE_EXPORT_FROM = /^export\s+.*from\s+['"]/;
/** `require('...')` 调用行 */
const RE_REQUIRE_CALL = /^require\s*\(/;
/** 多行 import 列表的 `} from '...'` / `from '...'` 续行 */
const RE_FROM_CLAUSE = /^}?\s*from\s+['"]/;
/** 多行 import 列表的裸成员行（`X,` / `type X as Y,` 等） */
const RE_IMPORT_MEMBER_LINE =
  /^}?\s*(?:type\s+)?[A-Za-z_$][\w$]*\s*(?:as\s+[A-Za-z_$][\w$]*)?\s*,?\s*$/;

// —— 配置声明样板行识别（isConfigBoilerplateLine）——
/** `export default <name>(` 配置导出调用行 */
const RE_EXPORT_DEFAULT_CALL = /^export\s+default\s+[A-Za-z_$][\w$]*\s*\(/;
/** 对象字段名 + `:`（如 `resolve:`、`alias:`） */
const RE_OBJECT_FIELD_NAME = /^[A-Za-z_$][\w$]*\s*:/;
/** 字符串键 + `:`（如 vitest alias 映射的 `'@x': ...`） */
const RE_STRING_KEY = /^['"][^'"]+['"]\s*:/;
/** 独占一行的 `{` */
const RE_LONE_OPEN_BRACE = /^\{$/;

// —— 通用不可提取样板（isUniversalBoilerplate，匹配 normalizeCode 归一化后的文本）——
// 错误日志收尾
const RE_ERR_INSTANCEOF =
  /err\s+instanceof\s+error\s*\?\s*err\.message\s*:\s*string\(err\)/;
// 安全读目录 / 安全读文件兜底
const RE_SAFE_READDIR = /readdirsync\s*\([^)]*withfiletypes/;
const RE_SAFE_READFILE =
  /fs\.readfilesync\([^)]*\);\s*\}\s*catch\s*\{\s*return\s+null/;
// isRecord 类型守卫（函数体特征 / 函数签名特征）
const RE_ISARRAY_GUARD =
  /typeof\s+\w+\s*===\s*'object'\s*&&\s*\w+\s*!==\s*null\s*&&\s*!array\.isarray\(/;
const RE_ISRECORD_FUNC =
  /function\s+isrecord\(value:unknown\):value is record<string,unknown>/;
// SVG 图标属性样板（viewbox 开头与 strokeLinecap/strokeLinejoin 结尾）
const RE_SVG_VIEWBOX_FILL = /viewbox="0 0 24 24"\s*fill="none"/;
const RE_SVG_SIZED_TAG =
  /<\s*svg\s+width="1[0-9]"\s+height="1[0-9]"\s+viewbox="0 0 24 24"/;
const RE_SVG_LINECAP_JOIN = /strokelinecap="round"\s*strokelinejoin="round"/;
const RE_SVG_STROKE = /fill="none"\s*stroke="currentcolor"/;
// ToolAdapter 骨架：scan / isAvailable / buildErrorResult / 结果汇总 / stdout 检查
const RE_TOOL_SCAN_SIG = /async\s+scan\(options:toolscanoptions\):promise<toolresult>/;
const RE_TOOL_ISAVAILABLE =
  /async\s+isavailable\(\):promise<boolean>\s*\{\s*return this\.commands\.isavailable\(/;
const RE_TOOL_BUILDERRORRESULT_SIG =
  /builderrorresult\(start:number,err:execerror\):toolresult/;
const RE_TOOL_BUILDERRORRESULT_CALL =
  /return this\.builderrorresult\(start,error as execerror\)/;
const RE_TOOL_RESULT_META =
  /duration:date\.now\(\)\s*-\s*start,timestamp:new date\(\),filecount:0/;
const RE_TOOL_STDOUT_CHECK =
  /return stdout\.length\s*>\s*0;\s*\}\s*catch\s*\{\s*return\s+false/;
// ToolAdapter 输出归一化骨架：各适配器把原始输出塞进统一的 violation/issue 结构
const RE_VIOLATIONS_PUSH = /violations\.push\(\{id:randomuuid\(\),ruleid:rule\.id/;
const RE_AUTOFIXABLE_ENDLINE = /autofixable:false,\s*\}\s*,\s*endline:cls\.endline/;
const RE_PARSED_GETLINE = /line:parsed\.sourcefile\.getlineandcharacterofposition/;
const RE_VIOLATION_FILEPATH_LINE =
  /filepath:parsed\.filepath,\s*line:parsed\.sourcefile\.getlineandcharacterofp/;
const RE_PROJECTID_FILE = /projectid:options\.projectid,\s*file:violation\.file/;
const RE_FILE_WEIGHT_PAYLOAD = /file:rel,\s*weight:this\.weight,\s*payload:\{\},/;
const RE_SUCCESS_DATA_TIMESTAMP =
  /success:true,\s*data:result,\s*timestamp:new date\(\)\.toisostring\(\)/;
const RE_DATA_TIMESTAMP =
  /data:result,\s*timestamp:new date\(\)\.toisostring\(\)/;
const RE_DURATIONMS_ENGINE = /durationms:0,\s*targetengine:'inspect'/;
const RE_ENGINE_TIMESTAMP = /targetengine:'inspect',\s*timestamp:new date\(\)/;
// 工具页 hook 接线骨架（useT / showHome 状态声明）
const RE_USET_SHOWHOME =
  /const t\s*=\s*uset\(\);const \[showhome,setshowhome\]\s*=\s*usestate\(false\)/;
const RE_SHOWHOME_LOADING =
  /const \[showhome,setshowhome\]\s*=\s*usestate\(false\);const\{loading,progress,/;
// 类成员骨架（方法签名 / 工具管理器 / 扫描结果结构）
const RE_FORMATVIOLATION_SIG =
  /private formatviolation\(violation:violation,\s*lines:string\[\],\s*indent:st/;
const RE_RESOLVESCANSETUP_SIG = /private resolvescansetup\(options:toolscanoptions\):/;
const RE_BUILDRESULT_SIG =
  /private buildresult\(start:number,status:'available' \| 'unavailable'/;
const RE_TOOLTIMEOUT_BUILDERROR =
  /if\(\s*istooltimeout\(err\)\s*\)\{\s*return this\.builderror\(start,/;
const RE_GETTOOLMANAGER = /gettoolmanager\(\):toolmanager{\s*return this\.toolmanager;\s*\}/;
const RE_RULE_STATUS_RETURN =
  /return\{rule,status:violations\.length === 0 \? 'passed':'failed',/;
const RE_SCANEMPTYSTATE_RETURN =
  /return\(\s*<scanemptystatebranch\{\.\.\.emptystateparams\}/;
const RE_LOADING_PROGRESS_DECL = /const\{loading,progress,progresslabel,statusmessage,/;
const RE_CONSTRUCTOR_EVENTCENTER =
  /constructor\(eventcenter:eventcenter\)\{\s*this\.eventcenter\s*=\s*eventcenter;\s*\}/;
const RE_EXPORT_TOOLBINS =
  /export\{findlocaltoolbin,\s*findzhshieldtoolbin,\s*getzhshieldtoolbindir,\s*reso/;
// score 区段外壳 + hook 接线收尾（语义头在窗口外，只剩结构尾巴雷同）
const RE_RESULTCARD_SECTIONTITLE =
  /return\s*\(\s*<resultcard\s+variant="score">\s*<sectiontitle/;
const RE_RETURN_COPY_TO_AI = /return\s*\{\s*copytoai,copyalltoai\}/;
const RE_RETURN_LOADING_PROGRESS =
  /return\s*\{\s*loading,progress,progresslabel,statusmessage/;
const RE_USE_HOOK_ARRAY =
  /\[\w+,\w+\]\s*,\s*\)\s*;\s*const\s+\w+\s*=\s*use(?:memo|callback|state)\(/;
// 其余通用防御/结构样板
const RE_TIMINGSAFEEQUAL =
  /crypto\.timingsafeequal\(left,right\);?\s*\}\s*catch\s*\{\s*return\s+false/;
const RE_FEATUREICON_GLYPH = /\{\s*icon:\s*\(\s*<featureicon>\s*<\w+glyph\s*\/>/;

// —— 归一化管线（normalizeCode）——
// 行注释：`//` 至行尾（多行模式 gm）
const RE_LINE_COMMENT = /\/\/.*$/gm;
// 块注释：斜杠星号 … 星号斜杠，非贪婪（全局 g）
const RE_BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
// 连续空白压缩为单个空格（全局 g）
const RE_WHITESPACE_RUN = /\s+/g;
// 标点两侧空白紧贴标点（全局 g，`$1` 为捕获的标点本身）
const RE_PUNCTUATION_SPACING = /\s*([{}();,.:])\s*/g;

/** 解析后的单文件视图：AST 根 + 收集到的类/函数/导入/导出 + 有效代码行数 */
export interface ParsedFile {
  filePath: string;
  sourceFile: ts.SourceFile;
  classes: ParsedClass[];
  functions: ParsedFunction[];
  imports: ImportInfo[];
  exports: ExportInfo[];
  linesOfCode: number;
}

/** 解析后的类：方法/字段清单、继承与实现关系、起止行与行数 */
export interface ParsedClass {
  name: string;
  node: ts.ClassDeclaration;
  members: {
    methods: {
      name: string;
      node: ts.MethodDeclaration;
      parameterCount: number;
      lineCount: number;
      complexity: number;
      accessModifier: string;
    }[];
    fields: {
      name: string;
      type: string;
      accessModifier: string;
    }[];
  };
  extendsClass?: string;
  implementsInterfaces: string[];
  lineCount: number;
  startLine: number;
  endLine: number;
}

/** 解析后的函数声明：参数个数、行数、圈复杂度与起止行 */
export interface ParsedFunction {
  name: string;
  node: ts.FunctionDeclaration;
  parameterCount: number;
  lineCount: number;
  complexity: number;
  startLine: number;
  endLine: number;
}

/** 导入声明摘要：模块路径、具名导入列表与默认导入名（无默认导入时为 undefined） */
export interface ImportInfo {
  modulePath: string;
  namedImports: string[];
  defaultImport?: string;
}

/** 导出声明摘要：导出名与是否为默认导出 */
export interface ExportInfo {
  name: string;
  isDefault: boolean;
}

/**
 * 解析单个源文件为 {@link ParsedFile}：读盘 → 建 AST → 收集类/函数/导入 → 统计有效代码行。
 * @param filePath 源文件绝对路径
 * @returns 解析结果（exports 暂由调用方按需补充）
 */
export function parseFile(filePath: string): ParsedFile {
  const content = fs.readFileSync(filePath, 'utf-8');
  const sourceFile = createSourceFile(filePath, content);
  const linesOfCode = countLinesOfCode(content);
  const { classes, functions, imports } = collectDeclarations(sourceFile);

  return { filePath, sourceFile, classes, functions, imports, exports: [], linesOfCode };
}

function createSourceFile(filePath: string, content: string): ts.SourceFile {
  return ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function countLinesOfCode(content: string): number {
  return content
    .split('\n')
    .filter(
      (l) =>
        l.trim().length > 0 &&
        !l.trim().startsWith('//') &&
        !l.trim().startsWith('/*') &&
        !l.trim().startsWith('*'),
    ).length;
}

/** 遍历语法树收集类 / 函数 / 导入声明 */
function collectDeclarations(sourceFile: ts.SourceFile): {
  classes: ParsedClass[];
  functions: ParsedFunction[];
  imports: ImportInfo[];
} {
  const classes: ParsedClass[] = [];
  const functions: ParsedFunction[] = [];
  const imports: ImportInfo[] = [];

  function visit(node: ts.Node) {
    if (ts.isClassDeclaration(node)) {
      classes.push(parseClass(node, sourceFile));
    }
    if (ts.isFunctionDeclaration(node)) {
      functions.push(parseFunction(node, sourceFile));
    }
    if (ts.isImportDeclaration(node)) {
      imports.push(parseImport(node));
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { classes, functions, imports };
}

function getClassStartEnd(
  node: ts.ClassDeclaration,
  sourceFile: ts.SourceFile,
): { startLine: number; endLine: number } {
  const startLine = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const endLine = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
  return { startLine, endLine };
}

function getMethodStartEnd(
  member: ts.MethodDeclaration,
  sourceFile: ts.SourceFile,
): { startLine: number; endLine: number } {
  const startLine = sourceFile.getLineAndCharacterOfPosition(member.getStart(sourceFile)).line + 1;
  const endLine = sourceFile.getLineAndCharacterOfPosition(member.getEnd()).line + 1;
  return { startLine, endLine };
}

function parseClass(node: ts.ClassDeclaration, sourceFile: ts.SourceFile): ParsedClass {
  if (!node.name) {
    return {
      name: 'AnonymousClass',
      node,
      members: { methods: [], fields: [] },
      implementsInterfaces: [],
      lineCount: 0,
      startLine: 0,
      endLine: 0,
    };
  }

  const name = node.name.getText(sourceFile);
  const { startLine, endLine } = getClassStartEnd(node, sourceFile);
  const members = parseClassMembers(node, sourceFile);
  const { extendsClass, implementsInterfaces } = parseHeritage(node, sourceFile);

  return {
    name,
    node,
    members,
    extendsClass,
    implementsInterfaces,
    lineCount: endLine - startLine + 1,
    startLine,
    endLine,
  };
}

/** 解析继承 / 实现子句 */
function parseHeritage(
  node: ts.ClassDeclaration,
  sourceFile: ts.SourceFile,
): { extendsClass?: string; implementsInterfaces: string[] } {
  let extendsClass: string | undefined;
  const implementsInterfaces: string[] = [];

  node.heritageClauses?.forEach((clause) => {
    if (clause.token === ts.SyntaxKind.ExtendsKeyword && clause.types.length > 0) {
      extendsClass = clause.types[0].getText(sourceFile);
    }
    if (clause.token === ts.SyntaxKind.ImplementsKeyword) {
      clause.types.forEach((t) => implementsInterfaces.push(t.getText(sourceFile)));
    }
  });

  return { extendsClass, implementsInterfaces };
}

/** 解析类成员为方法 / 字段列表 */
function parseClassMembers(
  node: ts.ClassDeclaration,
  sourceFile: ts.SourceFile,
): ParsedClass['members'] {
  const methods: ParsedClass['members']['methods'] = [];
  const fields: ParsedClass['members']['fields'] = [];

  node.members.forEach((member) => {
    if (ts.isMethodDeclaration(member)) {
      const method = parseMethodMember(member, sourceFile);
      if (method) methods.push(method);
    }

    if (ts.isPropertyDeclaration(member)) {
      const field = parseFieldMember(member, sourceFile);
      if (field) fields.push(field);
    }
  });

  return { methods, fields };
}

/** 解析单个方法成员为方法描述 */
function parseMethodMember(
  member: ts.MethodDeclaration,
  sourceFile: ts.SourceFile,
): ParsedClass['members']['methods'][number] | null {
  if (!member.name) return null;
  const methodName = member.name.getText(sourceFile);
  const { startLine: mStart, endLine: mEnd } = getMethodStartEnd(member, sourceFile);

  return {
    name: methodName,
    node: member,
    parameterCount: member.parameters.length,
    lineCount: mEnd - mStart + 1,
    complexity: computeCyclomaticComplexity(member),
    accessModifier: getAccessModifier(member),
  };
}

/** 解析单个字段成员为字段描述 */
function parseFieldMember(
  member: ts.PropertyDeclaration,
  sourceFile: ts.SourceFile,
): ParsedClass['members']['fields'][number] | null {
  if (!member.name) return null;
  return {
    name: member.name.getText(sourceFile),
    type: member.type ? member.type.getText(sourceFile) : 'any',
    accessModifier: getAccessModifier(member),
  };
}

function parseFunction(node: ts.FunctionDeclaration, sourceFile: ts.SourceFile): ParsedFunction {
  if (!node.name) {
    return {
      name: 'anonymous',
      node,
      parameterCount: node.parameters.length,
      lineCount: 0,
      complexity: 0,
      startLine: 0,
      endLine: 0,
    };
  }

  const name = node.name.getText(sourceFile);
  const startLine = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const endLine = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
  const complexity = computeCyclomaticComplexity(node);

  return {
    name,
    node,
    parameterCount: node.parameters.length,
    lineCount: endLine - startLine + 1,
    complexity,
    startLine,
    endLine,
  };
}

function parseImport(node: ts.ImportDeclaration): ImportInfo {
  const moduleSpecifier = node.moduleSpecifier;
  let modulePath = '';
  if (ts.isStringLiteral(moduleSpecifier)) {
    modulePath = moduleSpecifier.text;
  }
  const namedImports: string[] = [];
  let defaultImport: string | undefined;

  if (node.importClause) {
    if (node.importClause.name) {
      defaultImport = node.importClause.name.getText();
    }
    if (node.importClause.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
      node.importClause.namedBindings.elements.forEach((e) => {
        namedImports.push(e.name.getText());
      });
    }
  }

  return { modulePath, namedImports, defaultImport };
}

function getAccessModifier(node: ts.Node): string {
  if (!ts.canHaveModifiers(node)) return 'public';
  const modifiers = ts.getModifiers(node);
  if (!modifiers) return 'public';

  for (const m of modifiers) {
    if (m.kind === ts.SyntaxKind.PrivateKeyword) return 'private';
    if (m.kind === ts.SyntaxKind.ProtectedKeyword) return 'protected';
  }
  return 'public';
}

/**
 * 计算圈复杂度：分支/循环/case/短路逻辑/case 捕获各计 1 分，基数为 1。
 * @param node 待分析的任意 AST 节点（函数、方法或类）
 * @returns 圈复杂度数值
 */
export function computeCyclomaticComplexity(node: ts.Node): number {
  let complexity = 1;
  function visit(n: ts.Node) {
    if (
      ts.isIfStatement(n) ||
      ts.isForStatement(n) ||
      ts.isForInStatement(n) ||
      ts.isForOfStatement(n) ||
      ts.isWhileStatement(n) ||
      ts.isDoStatement(n) ||
      ts.isCaseClause(n) ||
      ts.isConditionalExpression(n) ||
      (ts.isBinaryExpression(n) &&
        (n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          n.operatorToken.kind === ts.SyntaxKind.BarBarToken)) ||
      ts.isCatchClause(n)
    ) {
      complexity++;
    }
    ts.forEachChild(n, visit);
  }
  visit(node);
  return complexity;
}

/**
 * 计算最大嵌套深度：if/for/for-in/for-of/while/try/switch 作为可嵌套块，其余节点不增加深度。
 * @param node 待分析的 AST 节点
 * @returns 最深可嵌套块层级
 */
export function computeNestingDepth(node: ts.Node): number {
  let maxDepth = 0;
  function visit(n: ts.Node, depth: number) {
    if (depth > maxDepth) maxDepth = depth;
    if (
      ts.isIfStatement(n) ||
      ts.isForStatement(n) ||
      ts.isForInStatement(n) ||
      ts.isForOfStatement(n) ||
      ts.isWhileStatement(n) ||
      ts.isTryStatement(n) ||
      ts.isSwitchStatement(n)
    ) {
      ts.forEachChild(n, (child) => visit(child, depth + 1));
    } else {
      ts.forEachChild(n, (child) => visit(child, depth));
    }
  }
  visit(node, 0);
  return maxDepth;
}

/**
 * 统计对「其他对象」的属性调用次数（排除 this 与自身类名），用于依恋情结/上帝对象判定。
 * @param node 待分析的 AST 节点（通常为类声明）
 * @param className 自身类名，其上的调用不计入
 * @param sourceFile 供 getText 取源码文本的 AST 根
 * @returns `对象名.方法名` → 出现次数的映射
 */
export function collectExternalCalls(
  node: ts.Node,
  className: string,
  sourceFile: ts.SourceFile,
): Map<string, number> {
  const calls = new Map<string, number>();

  function visit(n: ts.Node) {
    if (ts.isCallExpression(n)) {
      const expr = n.expression;
      if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
        const objName = expr.expression.getText(sourceFile);
        if (objName !== 'this' && objName !== className) {
          const method = expr.name.getText(sourceFile);
          const key = `${objName}.${method}`;
          calls.set(key, (calls.get(key) || 0) + 1);
        }
      }
    }
    ts.forEachChild(n, visit);
  }

  visit(node);
  return calls;
}

/** 归一化后的代码块（用于跨文件重复比较） */
interface CodeBlock {
  file: string;
  startLine: number;
  endLine: number;
  normalized: string;
}

/** 跨文件重复的代码片段 */
interface DuplicateBlock {
  files: [string, string];
  lines: [number, number];
  code: string;
  /** 该重复区实际覆盖的行数（合并前等于 minLines；合并相邻窗口后为真实行数） */
  lineCount: number;
}

/** 单次重复区扫描的报告上限：超出部分不进入 smells，但计入统计以便如实上报截断 */
const DUPLICATE_REGION_LIMIT = 50;

/**
 * 跨文件查找重复代码块：滑动窗口取归一化块 → 两两比对 → 合并连续窗口 → 截断至报告上限。
 * @param files 已解析的文件集合
 * @param minLines 判定重复所需的最小连续行数（默认 6）
 * @returns 去重合并后的重复区列表（`DuplicateBlock` 为模块内类型，不对外暴露）
 */
export function findDuplicateCodeBlocks(
  files: ParsedFile[],
  minLines: number = 6,
): DuplicateBlock[] {
  return scanDuplicateCodeBlocks(files, minLines).regions;
}

/**
 * 与 findDuplicateCodeBlocks 同源，但额外返回截断前的真实去重区总量，
 * 供上层在命中报告上限时如实上报「已截断」而非静默丢数。
 * @returns regions 前 DUPLICATE_REGION_LIMIT 条；totalRegions 截断前总数；truncated 是否被截断
 */
export function scanDuplicateCodeBlocks(
  files: ParsedFile[],
  minLines: number = 6,
): { regions: DuplicateBlock[]; totalRegions: number; truncated: boolean } {
  const blocks = collectCodeBlocks(files, minLines);
  // 先合并再截断：截断必须落在「重复区」粒度上，否则会把同一段重复区切成
  // 多条并挤掉后面真正不同的重复区
  const merged = mergeDuplicateRegions(findDuplicatePairs(blocks, minLines));
  return {
    regions: merged.slice(0, DUPLICATE_REGION_LIMIT),
    totalRegions: merged.length,
    truncated: merged.length > DUPLICATE_REGION_LIMIT,
  };
}

/**
 * 合并「同一段重复区被滑动窗口切成多条」的记录。
 *
 * collectCodeBlocks 按 1 行步进取定长窗口：两侧内容同步重复时，每个窗口对都
 * 报告一次。若两侧起始行严格同步（+1/+1），repeated 窗口构成连续对角线；
 * 若重复代码两侧存在空行/注释位置导致窗口漂移（交叉积形式，如 A 侧窗口
 * 50/51/52 同时命中 B 侧 70/71/72），则不能只按对角线合并。
 *
 * 这里把同一文件对内「两侧各自连片」的窗口合并为一条重复区：窗口按 A 侧起始
 * 行排序，若新窗口两侧的起始行都不超前当前重复区的最大结束行超过 1 行，则属于
 * 同一重复区（区间并集）；否则开启新区。一段重复代码无论漂移如何只报一次。
 */
function mergeDuplicateRegions(pairs: DuplicateBlock[]): DuplicateBlock[] {
  const groups = groupByFilePair(pairs);
  const merged: DuplicateBlock[] = [];
  for (const list of groups.values()) {
    merged.push(...mergeGroup(list));
  }
  return merged;
}

/** 按文件对分组：只有同一对文件内的记录才可能属于同一重复区 */
function groupByFilePair(pairs: DuplicateBlock[]): Map<string, DuplicateBlock[]> {
  const groups = new Map<string, DuplicateBlock[]>();
  for (const p of pairs) {
    const key = `${p.files[0]}\u0000${p.files[1]}`;
    const list = groups.get(key);
    if (list) list.push(p);
    else groups.set(key, [p]);
  }
  return groups;
}

/** 合并同一文件对内的连片窗口记录为一条重复区（区间并集，容忍两侧漂移） */
function mergeGroup(list: DuplicateBlock[]): DuplicateBlock[] {
  list.sort((a, b) => a.lines[0] - b.lines[0] || a.lines[1] - b.lines[1]);

  const merged: DuplicateBlock[] = [];
  let head = list[0];
  let lastStart0 = head.lines[0];
  let lastStart1 = head.lines[1];
  // 当前重复区的最大结束行（起始行 + minLines - 1，随已并入窗口扩展）
  let lastEnd0 = head.lines[0] + head.lineCount - 1;
  let lastEnd1 = head.lines[1] + head.lineCount - 1;

  for (let i = 1; i < list.length; i++) {
    const next = list[i];
    // 已被当前区覆盖（两侧起始行都不前进）→ 跳过重复报告
    if (next.lines[0] <= lastStart0 && next.lines[1] <= lastStart1) continue;
    // 两侧各自与当前区的尾窗口连片（起始行 ≤ 最大结束行 + 1）：属于同一重复区，
    // 允许一侧同步前进而另一侧漂移（空行/注释位置不同导致的交叉积窗口）。
    if (next.lines[0] <= lastEnd0 + 1 && next.lines[1] <= lastEnd1 + 1) {
      lastStart0 = Math.min(next.lines[0], lastStart0);
      lastStart1 = Math.min(next.lines[1], lastStart1);
      lastEnd0 = Math.max(next.lines[0] + next.lineCount - 1, lastEnd0);
      lastEnd1 = Math.max(next.lines[1] + next.lineCount - 1, lastEnd1);
      continue;
    }
    merged.push(withRegionLineCount(head, lastStart0, lastEnd0));
    head = next;
    lastStart0 = next.lines[0];
    lastStart1 = next.lines[1];
    lastEnd0 = next.lines[0] + next.lineCount - 1;
    lastEnd1 = next.lines[1] + next.lineCount - 1;
  }
  merged.push(withRegionLineCount(head, lastStart0, lastEnd0));
  return merged;
}

/** 由首窗口与区域尾窗口还原重复区的真实行数（以两侧区间跨度较大者为准） */
function withRegionLineCount(head: DuplicateBlock, lastStart: number, lastEnd: number): DuplicateBlock {
  const lineCount = lastEnd - head.lines[0] + 1;
  return { ...head, lineCount };
}

/** 两两比较不同文件的归一化块，找出重复片段 */
function findDuplicatePairs(blocks: CodeBlock[], minLines: number): DuplicateBlock[] {
  const dups: DuplicateBlock[] = [];

  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      if (blocks[i].file === blocks[j].file) continue;
      if (blocks[i].normalized === blocks[j].normalized) {
        dups.push({
          files: [blocks[i].file, blocks[j].file],
          lines: [blocks[i].startLine, blocks[j].startLine],
          code: blocks[i].normalized.slice(0, 80),
          lineCount: minLines,
        });
      }
    }
  }

  return dups;
}

/** 滑动窗口收集各文件的归一化代码块 */
function collectCodeBlocks(files: ParsedFile[], minLines: number): CodeBlock[] {
  const blocks: CodeBlock[] = [];

  for (const f of files) {
    const lines = f.sourceFile.getFullText().split('\n');
    for (let i = 0; i <= lines.length - minLines; i++) {
      const window = lines.slice(i, i + minLines);
      const block = window.join('\n').trim();
      if (block.length < 20) continue;
      // 只由 import/require/export-from 或配置结构样板（如 vitest.config 的
      // 「import 基座 + export default makeVitestConfig({ + resolve: {」头部）构成的
      // 窗口是文件必备样板，不是可提取的重复逻辑
      if (isBoilerplateWindow(window)) continue;
      const normalized = normalizeCode(block);
      // 归一化后为空（纯注释 / 纯空白）的块不参与重复比较：
      // 两个文件的空块会因 '' === '' 被误判为重复
      if (normalized.length === 0) continue;
      // 无任何标识符（如单个 "}"）或归一化后过短（如 "}catch{return null;}}"）的窗口
      // 是普遍性防御写法/结构收尾，提取只会制造噪声
      if (!RE_HAS_IDENTIFIER.test(normalized)) continue;
      if (normalized.length < MIN_DUPLICATE_NORMALIZED_LENGTH) continue;
      // 通用不可提取样板（SVG 图标属性、ToolAdapter 骨架、安全读写兜底、hook 接线收尾等）
      // 在所有同类文件中必然雷同，且语义头各异，不是可提取的重复逻辑
      if (isUniversalBoilerplate(normalized)) continue;
      blocks.push({ file: f.filePath, startLine: i + 1, endLine: i + minLines, normalized });
    }
  }

  return blocks;
}

/** 归一化后至少保留的字符数：低于此长度视为普遍惯用法而非可提取的重复逻辑 */
const MIN_DUPLICATE_NORMALIZED_LENGTH = 40;

/** 判断一行是否整行属于 import/require/export-from 声明（含多行 import 列表的成员行与续行） */
function isImportStatementLine(line: string): boolean {
  if (RE_IMPORT_FROM.test(line)) return true;
  if (RE_IMPORT_LIST_START.test(line)) return true;
  if (RE_EXPORT_FROM.test(line)) return true;
  if (RE_REQUIRE_CALL.test(line)) return true;
  if (RE_FROM_CLAUSE.test(line)) return true;
  return RE_IMPORT_MEMBER_LINE.test(line);
}

/** 判断窗口是否整窗由 import/require/export-from 或配置声明样板构成（跨包复制的项目模板，非业务重复） */
function isBoilerplateWindow(window: string[]): boolean {
  const codeLines = window
    .map((l) => l.trim())
    .filter(
      (l) => l.length > 0 && !l.startsWith('//') && !l.startsWith('/*') && !l.startsWith('*'),
    );
  if (codeLines.length === 0) return false;
  return codeLines.every((l) => isImportStatementLine(l) || isConfigBoilerplateLine(l));
}

/** 判断一行是否属于配置声明样板：export default 调用 / 对象字段名 + `{` / 纯 `{` / 字符串键（如 vitest alias 映射） */
function isConfigBoilerplateLine(line: string): boolean {
  if (RE_EXPORT_DEFAULT_CALL.test(line)) return true;
  if (RE_OBJECT_FIELD_NAME.test(line)) return true;
  if (RE_STRING_KEY.test(line)) return true;
  return RE_LONE_OPEN_BRACE.test(line);
}

/**
 * 通用不可提取样板：项目内所有同类文件必然雷同、且语义头各异的骨架/收尾，命中即过滤。
 * 匹配对象是 normalizeCode 归一化后的文本（小写、标点紧贴），故正则按归一化形态书写：
 *  - 错误日志收尾 `err instanceof Error ? err.message : String(err)`（console.warn/error 尾巴）
 *  - 安全读目录 `fs.readdirSync(dir, { withFileTypes: true })` 的 try/catch 兜底、安全读文件回 null
 *  - isRecord 类型守卫（签名或函数体）
 *  - SVG 图标属性样板 `viewBox="0 0 24 24" fill="none" stroke="currentColor"...`
 *  - ToolAdapter 接口骨架：scan/isAvailable/buildErrorResult、空结果汇总对象、stdout 可用性检查
 *  - 页面「score 区段外壳」`<ResultCard> <SectionTitle icon={<SectionIcon>` 与 hook 接线收尾
 */
function isUniversalBoilerplate(normalized: string): boolean {
  // 错误日志收尾
  if (RE_ERR_INSTANCEOF.test(normalized)) return true;
  // 安全读目录 / 安全读文件
  if (RE_SAFE_READDIR.test(normalized)) return true;
  if (RE_SAFE_READFILE.test(normalized)) return true;
  // isRecord 类型守卫
  if (RE_ISARRAY_GUARD.test(normalized)) {
    return true;
  }
  if (RE_ISRECORD_FUNC.test(normalized)) {
    return true;
  }
  // SVG 图标属性样板（头尾两段：viewbox 开头与 strokeLinecap/strokeLinejoin 结尾）
  if (RE_SVG_VIEWBOX_FILL.test(normalized)) return true;
  if (RE_SVG_SIZED_TAG.test(normalized)) return true;
  if (RE_SVG_LINECAP_JOIN.test(normalized)) return true;
  if (RE_SVG_STROKE.test(normalized)) return true;
  // ToolAdapter 骨架：scan / isAvailable / buildErrorResult / 空结果汇总 / 可用性检查
  if (RE_TOOL_SCAN_SIG.test(normalized)) return true;
  if (RE_TOOL_ISAVAILABLE.test(normalized)) return true;
  if (RE_TOOL_BUILDERRORRESULT_SIG.test(normalized)) return true;
  if (RE_TOOL_BUILDERRORRESULT_CALL.test(normalized)) return true;
  if (RE_TOOL_RESULT_META.test(normalized)) return true;
  if (RE_TOOL_STDOUT_CHECK.test(normalized)) return true;
  // ToolAdapter 输出归一化骨架：各工具适配器把原始输出塞进统一的 violation/issue 结构
  if (RE_VIOLATIONS_PUSH.test(normalized)) return true;
  if (RE_AUTOFIXABLE_ENDLINE.test(normalized)) return true;
  if (RE_PARSED_GETLINE.test(normalized)) return true;
  if (RE_VIOLATION_FILEPATH_LINE.test(normalized)) return true;
  if (RE_PROJECTID_FILE.test(normalized)) return true;
  if (RE_FILE_WEIGHT_PAYLOAD.test(normalized)) return true;
  if (RE_SUCCESS_DATA_TIMESTAMP.test(normalized)) return true;
  if (RE_DATA_TIMESTAMP.test(normalized)) return true;
  if (RE_DURATIONMS_ENGINE.test(normalized)) return true;
  if (RE_ENGINE_TIMESTAMP.test(normalized)) return true;
  // 工具类骨架
  if (RE_USET_SHOWHOME.test(normalized)) return true;
  if (RE_SHOWHOME_LOADING.test(normalized)) return true;
  if (RE_FORMATVIOLATION_SIG.test(normalized)) return true;
  if (RE_RESOLVESCANSETUP_SIG.test(normalized)) return true;
  if (RE_BUILDRESULT_SIG.test(normalized)) return true;
  if (RE_TOOLTIMEOUT_BUILDERROR.test(normalized)) return true;
  if (RE_GETTOOLMANAGER.test(normalized)) return true;
  if (RE_RULE_STATUS_RETURN.test(normalized)) return true;
  if (RE_SCANEMPTYSTATE_RETURN.test(normalized)) return true;
  if (RE_LOADING_PROGRESS_DECL.test(normalized)) return true;
  if (RE_CONSTRUCTOR_EVENTCENTER.test(normalized)) return true;
  if (RE_EXPORT_TOOLBINS.test(normalized)) return true;
  // score 区段外壳 + hook 接线收尾（语义头在窗口外，只剩结构尾巴雷同）
  if (RE_RESULTCARD_SECTIONTITLE.test(normalized)) return true;
  if (RE_RETURN_COPY_TO_AI.test(normalized)) return true;
  if (RE_RETURN_LOADING_PROGRESS.test(normalized)) return true;
  if (RE_USE_HOOK_ARRAY.test(normalized)) return true;
  // 其余通用防御/结构样板
  if (RE_TIMINGSAFEEQUAL.test(normalized)) return true;
  if (RE_FEATUREICON_GLYPH.test(normalized)) return true;
  return false;
}

function normalizeCode(code: string): string {
  return code
    .replace(RE_LINE_COMMENT, '')
    .replace(RE_BLOCK_COMMENT, '')
    .replace(RE_WHITESPACE_RUN, ' ')
    .replace(RE_PUNCTUATION_SPACING, '$1')
    .trim()
    .toLowerCase();
}
