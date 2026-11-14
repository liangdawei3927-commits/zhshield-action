/**
 * 「噪声目录」基线集合（递归遍历 / 项目根下探时跳过）。
 *
 * ## 为什么集中到这里
 *
 * 这七个目录名曾在四处各写一份，且每处注释都手写着「与 X 对齐」「同口径」：
 *
 *   · `@zh/kernel` `file.ts` 的 SKIP_DIRS（glob 遍历）
 *   · `@zh/kernel` `runner/scan-utils.ts` 的 NOISE_DIRS（源码根探测）
 *   · `@zh/pipeline` `project-profile.ts` 的 NESTED_PROBE_NOISE_DIRS（容器目录下探）
 *   · `@zh/dependency` `project-root.ts` 的 NESTED_PROBE_NOISE_DIRS（锁文件下探）
 *
 * 「靠注释约定对齐」本质上没有约束力：改一处、忘三处不会报错，只会让某个入口
 * 开始把构建产物当源码，或者把 vendored 目录当成用户项目 —— 两种都表现为
 * 扫描结果莫名多出几百个文件，很难倒查。收成单一常量后，改一处即全仓生效。
 *
 * ## 边界：这不是「全仓唯一的目录黑名单」
 *
 * 各包还有若干**语义不同**的更大集合，它们额外排除测试与夹具目录
 * （`__tests__` / `fixtures` / `test` 等）或语言专属产物（`__pycache__` /
 * `target` / `.venv`）。那些集合的排除面更大、判断依据也不同
 * （例如安全扫描要排除刻意构造的攻击样本），**不应**并入本常量 ——
 * 合并会把「跳过测试目录」的语义强加给源码根探测，反而误伤。
 *
 * 本常量只承载上述四处的**共同基线**：包依赖、构建输出、工具缓存。
 */
export const NOISE_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  'release',
  '.turbo',
  '.cache',
]);
