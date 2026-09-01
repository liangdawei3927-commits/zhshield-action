import * as ts from 'typescript';
import * as fs from 'fs';

export interface ParsedFile {
  filePath: string;
  sourceFile: ts.SourceFile;
  classes: ParsedClass[];
  functions: ParsedFunction[];
  imports: ImportInfo[];
  exports: ExportInfo[];
  linesOfCode: number;
}

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

export interface ParsedFunction {
  name: string;
  node: ts.FunctionDeclaration;
  parameterCount: number;
  lineCount: number;
  complexity: number;
  startLine: number;
  endLine: number;
}

export interface ImportInfo {
  modulePath: string;
  namedImports: string[];
  defaultImport?: string;
}

export interface ExportInfo {
  name: string;
  isDefault: boolean;
}

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
}

export function findDuplicateCodeBlocks(
  files: ParsedFile[],
  minLines: number = 6,
): DuplicateBlock[] {
  const blocks = collectCodeBlocks(files, minLines);
  return findDuplicatePairs(blocks).slice(0, 50);
}

/** 滑动窗口收集各文件的归一化代码块 */
function collectCodeBlocks(files: ParsedFile[], minLines: number): CodeBlock[] {
  const blocks: CodeBlock[] = [];

  for (const f of files) {
    const lines = f.sourceFile.getFullText().split('\n');
    for (let i = 0; i <= lines.length - minLines; i++) {
      const block = lines
        .slice(i, i + minLines)
        .join('\n')
        .trim();
      if (block.length < 20) continue;
      const normalized = normalizeCode(block);
      // 归一化后为空（纯注释 / 纯空白）的块不参与重复比较：
      // 两个文件的空块会因 '' === '' 被误判为重复
      if (normalized.length === 0) continue;
      blocks.push({ file: f.filePath, startLine: i + 1, endLine: i + minLines, normalized });
    }
  }

  return blocks;
}

/** 两两比较不同文件的归一化块，找出重复片段 */
function findDuplicatePairs(blocks: CodeBlock[]): DuplicateBlock[] {
  const dups: DuplicateBlock[] = [];

  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      if (blocks[i].file === blocks[j].file) continue;
      if (blocks[i].normalized === blocks[j].normalized) {
        dups.push({
          files: [blocks[i].file, blocks[j].file],
          lines: [blocks[i].startLine, blocks[j].startLine],
          code: blocks[i].normalized.slice(0, 80),
        });
      }
    }
  }

  return dups;
}

function normalizeCode(code: string): string {
  return code
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{}();,.:])\s*/g, '$1')
    .trim()
    .toLowerCase();
}
