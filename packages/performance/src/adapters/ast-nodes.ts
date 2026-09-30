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
 * 循环的「被遍历表达式」节点：for-of/for-in 取 iterable，while/do-while 与 C 风格 for 取循环条件。
 * 注意 TS 5.9 的 AST 里 while/do-while 的条件字段是 `expression`（不是 `condition`）。
 */
export function iterableExpressionOf(node: ts.Node): ts.Expression | undefined {
  if (
    ts.isForOfStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node)
  ) {
    return node.expression;
  }
  if (ts.isForStatement(node)) return node.condition ?? undefined;
  return undefined;
}

/**
 * 循环的「被遍历表达式」文本；for(;;) 无 condition 时退化为空串。
 */
export function iterableTextOf(node: ts.Node, sourceFile: ts.SourceFile): string {
  return iterableExpressionOf(node)?.getText(sourceFile) ?? '';
}

/** 该函数是否被直接注册为 ipcMain 监听器（`ipcMain.handle('ch', () => ...)`） */
/** 收集绑定模式引入的所有名字（`const { a, b: c } = x` → a, c；`const [d, , e]` → d, e） */
export function bindingNamesOf(name: ts.BindingName, into: Set<string> = new Set()): Set<string> {
  if (ts.isIdentifier(name)) {
    into.add(name.text);
    return into;
  }
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    bindingNamesOf(element.name, into);
  }
  return into;
}

/** 该循环语句自己引入的名字（for-of/for-in 的 initializer、C 风格 for 的 init 声明；while/do 无） */
export function loopBindingNamesOf(node: ts.Node): ReadonlySet<string> {
  const names = new Set<string>();
  if (ts.isForOfStatement(node) || ts.isForInStatement(node)) {
    if (ts.isVariableDeclarationList(node.initializer)) {
      for (const decl of node.initializer.declarations) bindingNamesOf(decl.name, names);
    } else if (ts.isIdentifier(node.initializer)) {
      names.add(node.initializer.text);
    }
    return names;
  }
  if (
    ts.isForStatement(node) &&
    node.initializer !== undefined &&
    ts.isVariableDeclarationList(node.initializer)
  ) {
    for (const decl of node.initializer.declarations) bindingNamesOf(decl.name, names);
  }
  return names;
}

function loopStatementOf(node: ts.Node): ts.Statement | undefined {
  if (
    ts.isForStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node)
  ) {
    return node.statement;
  }
  return undefined;
}

/**
 * 循环体里**直接**声明的局部名（不下钻嵌套函数，也停在本层之后的第一个嵌套循环处）。
 *
 * `for (const section of SECTIONS) { const deps = pkg[section]; for (const d of Object.keys(deps)) }`
 * 里最内层遍历的 `deps` 并非外层循环的绑定，而是外层循环体内的局部量 —— 它的大小由外层那一轮
 * 的输入决定，仍属「沿同一棵数据往下走」而非与外层相乘，故必须计入外层那一轮的可见名。
 *
 * 只收集直接声明：更深的循环体属于更内层那一轮，把它算进来会让跨层乘法循环被误判成线性遍历。
 * 排除 `let k = 0` 这类**裸数字字面量**初始化的计数器：它每轮都从 0 重新跑满全量范围，
 * 是与外层相乘的独立维度，不是派生集合。
 */
export function declaredNamesInLoopBody(node: ts.Node): ReadonlySet<string> {
  const names = new Set<string>();
  const body = loopStatementOf(node);
  if (body === undefined) return names;
  const visit = (current: ts.Node): void => {
    if (isFunctionLike(current)) return;
    if (current !== body && isAnyLoop(current)) return;
    if (ts.isVariableDeclaration(current) && !isFreshCounter(current)) {
      bindingNamesOf(current.name, names);
    }
    ts.forEachChild(current, visit);
  };
  visit(body);
  return names;
}

function isFreshCounter(decl: ts.VariableDeclaration): boolean {
  const init = unwrapExpression(decl.initializer);
  if (init === undefined) return false;
  if (ts.isNumericLiteral(init) || init.kind === ts.SyntaxKind.TrueKeyword) return true;
  return (
    (ts.isPrefixUnaryExpression(init) && init.operator === ts.SyntaxKind.MinusToken) ||
    (ts.isPrefixUnaryExpression(init) && init.operator === ts.SyntaxKind.PlusToken)
  );
}

function unwrapExpression(expr: ts.Expression | undefined): ts.Expression | undefined {
  if (expr === undefined) return undefined;
  if (ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr) || ts.isParenthesizedExpression(expr)) {
    return unwrapExpression(expr.expression);
  }
  return expr;
}

function isAnyLoop(node: ts.Node): boolean {
  return (
    ts.isForStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node)
  );
}

/** 表达式子树里被**引用**的名字（排除属性名与声明名，避免 `a.b.c` 把 `b`/`c` 误算成引用） */
export function referencedNamesOf(node: ts.Node): ReadonlySet<string> {
  const names = new Set<string>();
  const visit = (current: ts.Node): void => {
    if (ts.isIdentifier(current) && !isNonReferencePosition(current)) names.add(current.text);
    ts.forEachChild(current, visit);
  };
  visit(node);
  return names;
}

function isNonReferencePosition(id: ts.Identifier): boolean {
  const parent = id.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === id) return true;
  if (ts.isQualifiedName(parent) && parent.right === id) return true;
  if (ts.isPropertyAssignment(parent) && parent.name === id) return true;
  if (ts.isBindingElement(parent) && parent.propertyName === id) return true;
  return false;
}

const NO_CONST_NAMES: ReadonlySet<string> = new Set();

/**
 * 该表达式的可迭代规模是否**静态有界**。
 *
 * 字面量数组（`['a','b']`）与顶层 `const X = [...]` 的集合是配置而非输入数据，长度不随被扫描
 * 项目增长；把它当乘数会把「按固定 N 条规则扫 M 个文件」这种线性遍历误判成乘法循环。
 */
export function isStaticLengthIterable(
  expr: ts.Node,
  staticLengthConsts: ReadonlySet<string> = NO_CONST_NAMES,
): boolean {
  if (ts.isArrayLiteralExpression(expr)) return true;
  if (ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr) || ts.isParenthesizedExpression(expr)) {
    return isStaticLengthIterable(expr.expression, staticLengthConsts);
  }
  if (ts.isIdentifier(expr)) return staticLengthConsts.has(expr.text);
  return false;
}

/** 收集源文件顶层以数组字面量初始化的 const 名（`const A = [1,2]`、带 as/satisfies 包装） */
export function topLevelArrayConstNames(sourceFile: ts.SourceFile): ReadonlySet<string> {
  const names = new Set<string>();
  for (const stmt of sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || decl.initializer === undefined) continue;
      if (isStaticLengthIterable(decl.initializer)) names.add(decl.name.text);
    }
  }
  return names;
}

export function isIpcListener(node: ts.Node): boolean {
  const parent = node.parent;
  if (!ts.isCallExpression(parent)) return false;
  const callee = parent.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (!ts.isIdentifier(callee.expression) || callee.expression.text !== 'ipcMain') return false;
  return IPC_REGISTRATIONS.has(callee.name.text);
}
