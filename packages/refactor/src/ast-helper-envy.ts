import * as ts from 'typescript';
import { builtinModules } from 'node:module';

// ---------------------------------------------------------------------------
// 外部引用计数辅助：统计方法对「其他对象」的成员调用次数，用于依恋情结判定。
// 由 ast-helper 统一汇总导出，保持原有公开 API 与调用方路径不变。
// ---------------------------------------------------------------------------

// —— 外部引用计数（collectExternalCalls）——
// Feature Envy 只应对「另一个类实例」的成员调用计数。以下四类目标是系统性误报来源，
// 在计数前排除（语法级判定，不依赖 TypeChecker）：
//   1. this 与自身类名（原有行为）；
//   2. JS 运行时/宿主全局对象（Buffer/JSON/…）——工具用法，非可搬入的类；
//   3. Node 内置模块的导入绑定（path/fs/crypto…）——无状态标准库；
//   4. 方法自身的局部变量，以及带「非类」类型注解的参数（如 `lines: string[]`）。
// 保留：带类类型注解的参数与无注解参数（可能是协作者的类实例，维持经典 Feature Envy 检出）。

/** 不作为依恋目标的 JS 运行时/宿主全局对象名 */
const JS_GLOBAL_OBJECTS: ReadonlySet<string> = new Set([
  'Buffer',
  'JSON',
  'Math',
  'Date',
  'Object',
  'Array',
  'String',
  'Number',
  'Boolean',
  'BigInt',
  'Symbol',
  'Promise',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'RegExp',
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'Reflect',
  'Proxy',
  'Intl',
  'ArrayBuffer',
  'SharedArrayBuffer',
  'DataView',
  'Atomics',
  'console',
  'process',
  'globalThis',
  'global',
  'window',
  'document',
  'navigator',
  'location',
  'setTimeout',
  'setInterval',
  'setImmediate',
  'clearTimeout',
  'clearInterval',
  'clearImmediate',
  'queueMicrotask',
  'structuredClone',
  'fetch',
  'AbortController',
  'AbortSignal',
  'TextEncoder',
  'TextDecoder',
  'URL',
  'URLSearchParams',
  'performance',
]);

/** Node 内置模块裸名（取自 runtime 的 builtinModules，`node:` 前缀另行识别） */
const NODE_STDLIB_MODULES: ReadonlySet<string> = new Set(builtinModules);

function isStdlibSpecifier(specifier: string): boolean {
  return specifier.startsWith('node:') || NODE_STDLIB_MODULES.has(specifier);
}

/** 非类实例的类型节点 SyntaxKind（原始类型关键字 + 数组/元组/函数/字面量等复合类型） */
const NON_CLASS_TYPE_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.StringKeyword,
  ts.SyntaxKind.NumberKeyword,
  ts.SyntaxKind.BooleanKeyword,
  ts.SyntaxKind.BigIntKeyword,
  ts.SyntaxKind.SymbolKeyword,
  ts.SyntaxKind.ObjectKeyword,
  ts.SyntaxKind.AnyKeyword,
  ts.SyntaxKind.UnknownKeyword,
  ts.SyntaxKind.VoidKeyword,
  ts.SyntaxKind.NeverKeyword,
  ts.SyntaxKind.UndefinedKeyword,
  ts.SyntaxKind.NullKeyword,
  ts.SyntaxKind.ThisKeyword,
  ts.SyntaxKind.ArrayType,
  ts.SyntaxKind.TupleType,
  ts.SyntaxKind.FunctionType,
  ts.SyntaxKind.ConstructorType,
  ts.SyntaxKind.TypeLiteral,
  ts.SyntaxKind.TypePredicate,
  ts.SyntaxKind.TypeQuery,
  ts.SyntaxKind.IndexedAccessType,
  ts.SyntaxKind.MappedType,
  ts.SyntaxKind.ConditionalType,
  ts.SyntaxKind.InferType,
  ts.SyntaxKind.TemplateLiteralType,
  ts.SyntaxKind.ThisType,
]);

/** 容器/工具泛型类型名：其实例不是依恋目标 */
const NON_CLASS_TYPE_REFERENCES: ReadonlySet<string> = new Set([
  'Array',
  'ReadonlyArray',
  'Promise',
  'Map',
  'ReadonlyMap',
  'WeakMap',
  'Set',
  'ReadonlySet',
  'WeakSet',
  'Record',
  'Partial',
  'Required',
  'Readonly',
  'Pick',
  'Omit',
  'Exclude',
  'Extract',
  'NonNullable',
  'Parameters',
  'ReturnType',
  'InstanceType',
  'Awaited',
  'Iterable',
  'Iterator',
  'AsyncIterable',
  'AsyncIterator',
  'Generator',
  'AsyncGenerator',
  'ArrayLike',
  'Function',
]);

/** 具名类型引用是否指向非类（容器/工具泛型/全局内建） */
function isNonClassTypeReference(type: ts.TypeReferenceNode, sourceFile: ts.SourceFile): boolean {
  const name = type.typeName.getText(sourceFile);
  return NON_CLASS_TYPE_REFERENCES.has(name) || JS_GLOBAL_OBJECTS.has(name);
}

/**
 * 类型节点是否「非类实例」（原始类型/数组/元组/函数/字面量/联合全非类/工具泛型/全局内建）。
 * 判定为 true 时，该绑定不作为依恋目标。
 */
function isNonClassType(type: ts.TypeNode, sourceFile: ts.SourceFile): boolean {
  if (NON_CLASS_TYPE_KINDS.has(type.kind) || ts.isLiteralTypeNode(type)) return true;
  if (ts.isParenthesizedTypeNode(type) || ts.isTypeOperatorNode(type)) {
    return isNonClassType(type.type, sourceFile);
  }
  if (ts.isUnionTypeNode(type) || ts.isIntersectionTypeNode(type)) {
    return type.types.every((member) => isNonClassType(member, sourceFile));
  }
  if (ts.isTypeReferenceNode(type)) return isNonClassTypeReference(type, sourceFile);
  return false;
}

/** 收集方法内声明的局部变量名（含解构、for-of/for-in 与 catch 绑定）：本方法自身的工作数据不算外部对象 */
function collectLocalBindingNames(node: ts.Node): Set<string> {
  const names = new Set<string>();

  const addBindingName = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      names.add(name.text);
      return;
    }
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) addBindingName(element.name);
    }
  };

  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n)) {
      addBindingName(n.name);
    } else if (ts.isCatchClause(n) && n.variableDeclaration) {
      addBindingName(n.variableDeclaration.name);
    }
    ts.forEachChild(n, visit);
  };

  visit(node);
  return names;
}

/** 收集带「非类」类型注解的参数名：这类参数是值容器（如 `lines: string[]`），不作为依恋目标 */
function collectValueTypedParameterNames(node: ts.Node, sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();

  const visit = (n: ts.Node): void => {
    if (
      ts.isParameter(n) &&
      n.type &&
      ts.isIdentifier(n.name) &&
      isNonClassType(n.type, sourceFile)
    ) {
      names.add(n.name.text);
    }
    ts.forEachChild(n, visit);
  };

  visit(node);
  return names;
}

/** 收集来自 Node 内置模块的导入绑定名（含 `import * as ns` 命名空间、默认与具名导入） */
function collectStdlibImportBindings(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (!ts.isStringLiteral(specifier) || !isStdlibSpecifier(specifier.text)) continue;
    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.name) names.add(clause.name.text);
    const bindings = clause.namedBindings;
    if (!bindings) continue;
    if (ts.isNamespaceImport(bindings)) {
      names.add(bindings.name.text);
    } else {
      for (const element of bindings.elements) names.add(element.name.text);
    }
  }

  return names;
}

/**
 * 统计对「其他对象」的属性调用次数，用于依恋情结判定。排除：this/自身类名、
 * 方法局部变量与值类型参数、Node 内置模块导入绑定、JS 全局对象。
 * @param node 待分析的 AST 节点（通常为方法声明）
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
  const ignored = new Set<string>(['this', className, ...JS_GLOBAL_OBJECTS]);
  for (const name of collectLocalBindingNames(node)) ignored.add(name);
  for (const name of collectValueTypedParameterNames(node, sourceFile)) ignored.add(name);
  for (const name of collectStdlibImportBindings(sourceFile)) ignored.add(name);

  function visit(n: ts.Node) {
    if (ts.isCallExpression(n)) {
      const expr = n.expression;
      if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
        const objName = expr.expression.getText(sourceFile);
        if (!ignored.has(objName)) {
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
