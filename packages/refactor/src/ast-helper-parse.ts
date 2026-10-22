import * as ts from 'typescript';
import * as fs from 'fs';

// ---------------------------------------------------------------------------
// AST 解析辅助：把单个源文件解析为 ParsedFile，并收集类/函数/导入等声明信息。
// 同时提供圈复杂度与最大嵌套深度计算。由 ast-helper 统一汇总导出，
// 保持原有公开 API 与调用方路径不变。
// ---------------------------------------------------------------------------

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
