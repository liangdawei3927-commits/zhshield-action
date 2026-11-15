/**
 * Node.js 内置模块名（bare specifier）的单一事实源。
 *
 * ## 为什么集中到这里
 *
 * 这份表曾在两处各写一份，用途相同 —— 判断「一个 import/require 的裸说明符是不是
 * Node 内建模块」：
 *
 *   · `@zh/inspect` `ai-code/files.ts` —— 内建模块不是外部包，不该被判成「幻觉依赖」
 *   · `@zh/performance` `adapters/runtime-context.ts` —— 内建模块代表运行时可用的底层
 *     能力（`fs` / `child_process` …），是运行时上下文判定的输入之一
 *
 * 两处互不依赖，靠各自维护必然漂移，**且已经漂移了**（2026-11-14 核实）：
 * performance 那份 42 项，inspect 那份 39 项，缺 `async_hooks` / `inspector` / `sys`。
 * 漂移的代价是静默的 —— inspect 侧会把 `import 'async_hooks'` 当成一个没声明的外部
 * 包，在「幻觉依赖」规则里报出来；不报错、测试也未必红，只是多一条误报。
 *
 * ## 取值口径
 *
 * 取两处的并集，即 Node 现行文档里的内建模块全集：宁可多认一个内建模块（最坏是漏掉
 * 一条本可报出的幻觉依赖），也不要少认（那就是凭空造误报）。
 * 已废弃的 `sys`、`punycode` 一并保留：老项目里仍会出现这种写法。
 */
export const NODE_BUILTIN_MODULES: ReadonlySet<string> = new Set([
  'assert',
  'async_hooks',
  'buffer',
  'child_process',
  'cluster',
  'console',
  'constants',
  'crypto',
  'dgram',
  'diagnostics_channel',
  'dns',
  'domain',
  'events',
  'fs',
  'http',
  'http2',
  'https',
  'inspector',
  'module',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'punycode',
  'querystring',
  'readline',
  'repl',
  'stream',
  'string_decoder',
  'sys',
  'timers',
  'tls',
  'trace_events',
  'tty',
  'url',
  'util',
  'v8',
  'vm',
  'wasi',
  'worker_threads',
  'zlib',
]);
