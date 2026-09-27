/**
 * TypeScript AST 原语（ast-nodes.ts）
 *
 * 「怎么读这棵 AST」的零散判别与取文本逻辑，与「走一遍树收集什么」（ast-scan.ts）
 * 分开：本模块的函数全部只依赖一个 sourceFile / 文件路径，可被其他探测器直接复用。
 */
import * as ts from 'typescript';

/** Electron 主进程 IPC 监听器注册入口：这些调用的监听器实参即 IPC handler */
const IPC_REGISTRATIONS: ReadonlySet<string> = new Set(['handle', 'handleOnce', 'on']);

/**
 * 按扩展名选 ScriptKind。
 *
 * ast-helper.ts 固定用 TSX；此处必须按扩展名区分：.ts 被当成 TSX 解析时，
 * 泛型箭头函数 / 尖括号类型断言会被误读为 JSX，循环节点随之丢失。
 */
const SCRIPT_KINDS: Readonly<Record<string, ts.ScriptKind>> = {
  '.tsx': ts.ScriptKind.TSX,
  '.jsx': ts.ScriptKind.JSX,
  '.js': ts.ScriptKind.JS,
};

/** 该扩展名该用哪种 ScriptKind 解析（未知扩展名按 TS 处理） */
export function scriptKindOf(filePath: string): ts.ScriptKind {
  const dot = filePath.lastIndexOf('.');
  return SCRIPT_KINDS[filePath.slice(dot)] ?? ts.ScriptKind.TS;
}

/** 节点起始行（1 基）；position 参数须为 getStart 而非 getFullStart，否则注释行会偏移 */
export function lineOf(node: ts.Node, sourceFile: ts.SourceFile): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

/** 是否为函数族节点（判定 `undefined` 安全，字段初始化可能没有 initializer） */
export function isFunctionLike(node: ts.Node | undefined): node is ts.FunctionLikeDeclaration {
  if (node === undefined) return false;
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

/** 是否为类的成员节点（方法 / 构造器 / 存取器），区别于自由函数与箭头函数 */
export function isClassMember(node: ts.FunctionLikeDeclaration): boolean {
  return (
    !ts.isFunctionDeclaration(node) &&
    !ts.isFunctionExpression(node) &&
    !ts.isArrowFunction(node)
  );
}

/** 装饰器名：`@Get('/x')` → `Get`，`@Override` → `Override` */
export function decoratorNamesOf(node: ts.Node, sourceFile: ts.SourceFile): string[] {
  if (!ts.canHaveDecorators(node)) return [];
  return (ts.getDecorators(node) ?? []).map((decorator) =>
    ts.isCallExpression(decorator.expression)
      ? decorator.expression.expression.getText(sourceFile)
      : decorator.expression.getText(sourceFile),
  );
}

/** 类 `implements` 的接口名（跳过 `extends` 子句） */
export function implementedInterfacesOf(
  node: ts.ClassDeclaration | ts.ClassExpression,
  sourceFile: ts.SourceFile,
): string[] {
  const implemented: string[] = [];
  for (const clause of node.heritageClauses ?? []) {
    if (clause.token !== ts.SyntaxKind.ImplementsKeyword) continue;
    for (const type of clause.types) implemented.push(type.expression.getText(sourceFile));
  }
  return implemented;
}

/** 形参类型文本；无类型注解时退化为形参名（Express `(req, res)` 判定靠这个退化） */
export function paramTypesOf(
  node: ts.FunctionLikeDeclaration,
  sourceFile: ts.SourceFile,
): string[] {
  return node.parameters.map(
    (param) => param.type?.getText(sourceFile) ?? param.name.getText(sourceFile),
  );
}

/**
 * 循环的「被遍历表达式」文本：for-of/for-in 取 iterable，while/do-while 与 C 风格 for 取循环条件。
 * 注意 TS 5.9 的 AST 里 while/do-while 的条件字段是 `expression`（不是 `condition`）。
 */
export function iterableTextOf(node: ts.Node, sourceFile: ts.SourceFile): string {
  if (
    ts.isForOfStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node)
  ) {
    return node.expression.getText(sourceFile);
  }
  if (ts.isForStatement(node)) return node.condition?.getText(sourceFile) ?? '';
  return '';
}

/** 该函数是否被直接注册为 ipcMain 监听器（`ipcMain.handle('ch', () => ...)`） */
export function isIpcListener(node: ts.Node): boolean {
  const parent = node.parent;
  if (!ts.isCallExpression(parent)) return false;
  const callee = parent.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (!ts.isIdentifier(callee.expression) || callee.expression.text !== 'ipcMain') return false;
  return IPC_REGISTRATIONS.has(callee.name.text);
}
