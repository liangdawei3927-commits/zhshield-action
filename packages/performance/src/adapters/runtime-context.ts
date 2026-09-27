/**
 * 运行时上下文判定（runtime-context.ts）
 *
 * 同步阻塞 IO 是不是问题，取决于**它在哪种执行上下文里跑**：
 *   · 浏览器主线程 / Electron 渲染进程 → 阻塞的是用户界面；
 *   · Electron 主进程 IPC handler / 循环内 → 阻塞事件循环，窗口无响应；
 *   · Node 服务端请求路径（NestJS guard/interceptor/pipe/controller/resolver、
 *     Express 风格 (req, res) handler）→ 阻塞**所有并发请求**；
 *   · Node CLI / 批处理 / 构建脚本 / 模块初始化 / 构造函数 / 普通函数 → 一次性调用。
 *
 * 最后一种不是问题：事件循环里本就没有并发可阻塞；批处理紧循环里同步读甚至比
 * `await` 更快（无 Promise 开销、局部性更好）。本仓正是这种形态 —— 45 处同步 IO
 * 全是配置加载 / token 读取 / 启动初始化 / 有界批扫。历史实现把这条规则当浏览器规则
 * 用在 Node 代码库上（消息还写「影响页面响应」「移至 Worker 线程」），是误报根因。
 *
 * 判定信号刻意保持简单可解释，不做推断引擎；宁可漏报也不在高置信度上造假精度。
 */
import type { FileScan, ScopeFacts, ScopeKind, SyncCallSite } from './ast-scan';

/** 单文件所处的运行时上下文 */
export type RuntimeContext = 'browser' | 'electron-renderer' | 'electron-main' | 'node';

/** Node 内建模块名（bare specifier；`node:` 前缀与子路径如 `fs/promises` 另判） */
const NODE_BUILTINS: ReadonlySet<string> = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants',
  'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain', 'events', 'fs', 'http', 'http2',
  'https', 'inspector', 'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'punycode',
  'querystring', 'readline', 'repl', 'stream', 'string_decoder', 'sys', 'timers', 'tls',
  'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
]);

/** 浏览器 / DOM 全局（大小写敏感精确匹配，故 `DocumentBuilder` 之类不算） */
const DOM_GLOBALS: ReadonlySet<string> = new Set([
  'window',
  'document',
  'localStorage',
  'navigator',
]);

/** Electron 渲染进程专属 API（主进程不存在，用它们即可判定渲染侧） */
const ELECTRON_RENDERER_APIS: ReadonlySet<string> = new Set([
  'ipcRenderer',
  'contextBridge',
  'webFrame',
]);

/** 一次性执行的作用域：随模块求值 / 对象构造各跑一次，不在请求或事件循环的关键路径上 */
const ONE_SHOT_SCOPES: ReadonlySet<ScopeKind> = new Set(['constructor', 'field-init', 'module']);

/** NestJS 请求路径接口（`implements` 命中即整个类的请求方法都算请求路径） */
const NESTJS_REQUEST_INTERFACES: ReadonlySet<string> = new Set([
  'CanActivate',
  'NestInterceptor',
  'PipeTransform',
  'NestMiddleware',
]);

/** NestJS 请求处理方法上的装饰器（HTTP 方法装饰器 + 请求管道装饰器） */
const NESTJS_HANDLER_DECORATORS: ReadonlySet<string> = new Set([
  'Get', 'Post', 'Put', 'Delete', 'Patch', 'All', 'Options', 'Head', 'Sse',
  'UseGuards', 'UseInterceptors', 'UsePipes',
]);

/** Express 风格处理器的第 1 / 2 形参（类型注解文本；无注解时形参名会退化进来） */
const EXPRESS_REQUEST_PARAMS: ReadonlySet<string> = new Set([
  'Request', 'IncomingMessage', 'Express.Request', 'req',
]);
const EXPRESS_RESPONSE_PARAMS: ReadonlySet<string> = new Set([
  'Response', 'ServerResponse', 'Express.Response', 'res',
]);

/**
 * 判定单文件所处的运行时上下文。
 *
 * electron：命中渲染侧 API 或 DOM 全局 → 渲染进程；否则按 Electron 目录约定视为主进程
 * （`packages/desktop/electron/**` 即主进程代码），这是比「必须出现 ipcMain/app」更稳的判据。
 * browser：不用任何 Node 内建模块 + 用 DOM 全局 —— 没有内建模块就没有服务端运行时。
 * 其余（用内建模块 / 两者都不用）一律 node。
 */
export function classifyRuntime(scan: FileScan): RuntimeContext {
  if (scan.moduleSpecifiers.has('electron')) {
    return usesAny(scan, ELECTRON_RENDERER_APIS) || usesAny(scan, DOM_GLOBALS)
      ? 'electron-renderer'
      : 'electron-main';
  }
  if (!usesNodeBuiltin(scan) && usesAny(scan, DOM_GLOBALS)) return 'browser';
  return 'node';
}

/** 该同步 IO 调用是否真的落在延迟敏感的执行上下文里（决定是否产出 high 级问题） */
export function isLatencySensitive(site: SyncCallSite, context: RuntimeContext): boolean {
  if (context === 'browser' || context === 'electron-renderer') return true;
  if (ONE_SHOT_SCOPES.has(site.kind)) return false;
  if (context === 'electron-main') return site.loopDepth > 0 || site.ipcHandler;
  return isRequestHandler(site);
}

function usesNodeBuiltin(scan: FileScan): boolean {
  for (const specifier of scan.moduleSpecifiers) {
    if (specifier.startsWith('node:')) return true;
    if (NODE_BUILTINS.has(specifier.split('/')[0])) return true;
  }
  return false;
}

function usesAny(scan: FileScan, names: ReadonlySet<string>): boolean {
  for (const name of names) {
    if (scan.identifierNames.has(name)) return true;
  }
  return false;
}

/** NestJS guard/interceptor/pipe/controller/resolver，或 Express 风格 (req, res) handler */
function isRequestHandler(scope: ScopeFacts): boolean {
  for (const iface of scope.implementsInterfaces) {
    if (NESTJS_REQUEST_INTERFACES.has(iface)) return true;
  }
  for (const decorator of scope.decorators) {
    if (NESTJS_HANDLER_DECORATORS.has(decorator)) return true;
  }
  return isExpressHandler(scope.paramTypes);
}

function isExpressHandler(paramTypes: readonly string[]): boolean {
  const [first, second] = paramTypes;
  if (first === undefined || second === undefined) return false;
  return EXPRESS_REQUEST_PARAMS.has(first) && EXPRESS_RESPONSE_PARAMS.has(second);
}
