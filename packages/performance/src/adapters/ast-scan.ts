/**
 * 复杂度 AST 扫描（ast-scan.ts）
 *
 * 纯 TypeScript 编译器 API 的**事实提取层**：只回答「代码长什么样」，
 * 不做任何判定（阈值在 complexity-detector.ts，上下文政策在 runtime-context.ts）。
 *
 * 为什么不用正则 + 花括号深度：词法扫描分不清
 *   `for (const e of evidence) addEvidence(file, e);`   // 无花括号循环体
 * 与紧随其后的 `}`，会把下一个函数体的 `{` 误记为循环体，凭空造出幻影嵌套层数。
 * AST 的父子关系没有这个歧义 —— 无花括号循环体同样是该循环节点的子节点。
 */
import * as ts from 'typescript';
import {
  decoratorNamesOf,
  implementedInterfacesOf,
  isClassMember,
  isFunctionLike,
  isIpcListener,
  iterableTextOf,
  lineOf,
  paramTypesOf,
  scriptKindOf,
} from './ast-nodes';

/**
 * 本规则追踪的同步阻塞 IO API。
 * 保持历史集合：issue id 内嵌这些名字（`complexity-sync-io-<file>-<api>`），
 * 桌面端按 id 去重，增删会改变既有 id 契约。
 */
export const SYNC_IO_APIS: ReadonlySet<string> = new Set([
  'readFileSync',
  'writeFileSync',
  'appendFileSync',
  'execSync',
  'spawnSync',
]);

/** 计入「循环嵌套层数」的语句种类（for / for-in / for-of / while / do-while） */
const LOOP_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
]);

/** 最深循环链：真实 AST 嵌套层数 + 最内层被遍历的表达式 + 该链最外层循环所在行 */
export interface DeepestLoopChain {
  readonly depth: number;
  /** 最内层循环的遍历源表达式文本（for/while/do 取循环条件），供人工秒级定位 */
  readonly innermostIterable: string;
  /** 最深链中最外层那个循环的起始行（1 基） */
  readonly outermostLine: number;
}

/** 调用点所在作用域的形态；`constructor` / `field-init` / `module` 属一次性初始化 */
export type ScopeKind = 'method' | 'function' | 'constructor' | 'field-init' | 'module';

/** 调用点所在作用域的静态特征（供运行上下文判定） */
export interface ScopeFacts {
  readonly kind: ScopeKind;
  /** 所在函数/方法上的装饰器名（`@Get('/x')` → `Get`） */
  readonly decorators: readonly string[];
  /** 所在类 `implements` 的接口名 */
  readonly implementsInterfaces: readonly string[];
  /** 所在函数的形参类型文本；无类型注解时退化为形参名（Express (req, res) 判定用） */
  readonly paramTypes: readonly string[];
}

/** 单个同步阻塞 IO 调用点的全部事实 */
export interface SyncCallSite extends ScopeFacts {
  readonly apiName: string;
  /** 调用点所在行（1 基） */
  readonly line: number;
  /** 调用点所处的循环嵌套层数（0 = 不在任何循环内） */
  readonly loopDepth: number;
  /** 该函数是否作为 ipcMain 监听器注册（Electron 主进程 IPC handler） */
  readonly ipcHandler: boolean;
}

/** 单文件扫描结果 */
export interface FileScan {
  readonly deepestLoops: DeepestLoopChain | null;
  readonly syncCalls: readonly SyncCallSite[];
  /** import / require() / import() 的模块说明符 */
  readonly moduleSpecifiers: ReadonlySet<string>;
  /** 文件中出现过的全部标识符名（DOM 全局 / electron API 判定用，大小写敏感） */
  readonly identifierNames: ReadonlySet<string>;
}

interface WalkFrame {
  readonly loopDepth: number;
  /** 当前活跃循环链的起始行（链首 = 最外层） */
  readonly loopChain: readonly number[];
  readonly scope: ScopeFacts;
  readonly ipcHandler: boolean;
}

/** 模块顶层作用域：没有任何函数包裹，代码只随模块求值执行一次 */
const MODULE_SCOPE: ScopeFacts = {
  kind: 'module',
  decorators: [],
  implementsInterfaces: [],
  paramTypes: [],
};

/**
 * 扫描单个源文件，提取循环嵌套与同步 IO 调用点的事实。
 * 纯静态：不执行任何被扫描代码；源码畸形时按「解析出的部分」返回，不抛异常。
 */
export function scanSourceFile(filePath: string, content: string): FileScan {
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKindOf(filePath),
  );
  const identifierNames = new Set<string>();
  const moduleSpecifiers = new Set<string>();
  const syncCalls: SyncCallSite[] = [];
  const classStack: string[][] = [];
  let deepestLoops: DeepestLoopChain | null = null;

  const line = (node: ts.Node): number => lineOf(node, sourceFile);

  /** 进入函数/方法/字段初始化时切换作用域；其余节点沿用外层作用域 */
  const scopeOf = (node: ts.Node, inherited: ScopeFacts): ScopeFacts => {
    const implementsInterfaces = classStack[classStack.length - 1] ?? [];
    if (ts.isConstructorDeclaration(node)) {
      return { ...MODULE_SCOPE, kind: 'constructor', implementsInterfaces };
    }
    if (ts.isPropertyDeclaration(node) && !isFunctionLike(node.initializer)) {
      return { ...MODULE_SCOPE, kind: 'field-init', implementsInterfaces };
    }
    if (!isFunctionLike(node)) return inherited;
    return {
      kind: isClassMember(node) ? 'method' : 'function',
      decorators: decoratorNamesOf(node, sourceFile),
      implementsInterfaces,
      paramTypes: paramTypesOf(node, sourceFile),
    };
  };

  const visit = (node: ts.Node, frame: WalkFrame): void => {
    if (ts.isIdentifier(node)) identifierNames.add(node.text);
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      moduleSpecifiers.add(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node)) {
      const apiName = syncApiNameOf(node);
      if (apiName !== null) {
        syncCalls.push({
          ...frame.scope,
          apiName,
          line: line(node),
          loopDepth: frame.loopDepth,
          ipcHandler: frame.ipcHandler,
        });
      }
      addDynamicSpecifier(node, moduleSpecifiers);
    }

    const isLoop = LOOP_KINDS.has(node.kind);
    const loopDepth = isLoop ? frame.loopDepth + 1 : frame.loopDepth;
    const loopChain = isLoop ? [...frame.loopChain, line(node)] : frame.loopChain;
    // 仅在层数刷新纪录时更新，层数相同则保留先出现的那条链（并列取最靠前）
    if (isLoop && loopDepth > (deepestLoops?.depth ?? 0)) {
      deepestLoops = {
        depth: loopDepth,
        innermostIterable: iterableTextOf(node, sourceFile),
        outermostLine: loopChain[0] ?? line(node),
      };
    }

    const isClass = ts.isClassDeclaration(node) || ts.isClassExpression(node);
    if (isClass) classStack.push(implementedInterfacesOf(node, sourceFile));
    const childFrame: WalkFrame = {
      loopDepth,
      loopChain,
      scope: scopeOf(node, frame.scope),
      ipcHandler: isFunctionLike(node) ? isIpcListener(node) : frame.ipcHandler,
    };
    ts.forEachChild(node, (child) => visit(child, childFrame));
    if (isClass) classStack.pop();
  };

  visit(sourceFile, {
    loopDepth: 0,
    loopChain: [],
    scope: MODULE_SCOPE,
    ipcHandler: false,
  });
  return { deepestLoops, syncCalls, moduleSpecifiers, identifierNames };
}

/** 取出被调用 API 的名字；不在追踪集合内返回 null */
function syncApiNameOf(call: ts.CallExpression): string | null {
  const callee = call.expression;
  if (ts.isPropertyAccessExpression(callee) && SYNC_IO_APIS.has(callee.name.text)) {
    return callee.name.text;
  }
  if (ts.isIdentifier(callee) && SYNC_IO_APIS.has(callee.text)) return callee.text;
  return null;
}

/** 收集 `require('x')` / `import('x')` 形式的模块说明符 */
function addDynamicSpecifier(call: ts.CallExpression, into: Set<string>): void {
  const callee = call.expression;
  const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
  const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
  if (!isRequire && !isDynamicImport) return;
  const [first] = call.arguments;
  if (first !== undefined && ts.isStringLiteralLike(first)) into.add(first.text);
}
