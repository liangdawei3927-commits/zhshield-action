/**
 * 工具扫描的默认排除目录（semgrep 等源码扫描工具通用）。
 *
 * **为什么放在 shared 而不是各适配器各写一份**：扫描范围直接决定耗时与噪声。
 *   · 排除 `node_modules` / `dist` / `build` / `coverage`：生成物与依赖不是人工编辑的源码，
 *     扫它们既慢又会自触发误报（构建产物里常带着刻意构造的坏味道样本）。
 *   · 排除 `__tests__` / `fixtures` / `__fixtures__` / `__mocks__`：测试夹具是**扫描器的输入**
 *     而非待检源码，里面常有刻意植入的漏洞样本（用于验证引擎检出能力），当生产代码上报即为误报。
 *
 * **漏掉排除目录的代价是实测出来的，不是想象的**（2026-11-04 A14 复测）：
 *   · 带 9 个排除项、目标 `packages/`：semgrep 单次 3.6s
 *   · 不带任何排除、目标仓库根：semgrep 单次 37.1s（**10 倍**）
 * 同一台机器、同一份规则，只因扫描目标从「源码目录」退化成「仓库根」，
 * 连带把整仓 `.git` / 构建产物 / 报告目录全走了一遍。
 * security 域的 semgrep 适配器曾单独实现参数拼装而漏掉排除项，
 * 单此一项就把该域耗时从 ~20s 抬到 ~108s。
 *
 * 故：拼装扫描参数时**一律**用这份清单，不要在适配器里另写。
 */
export const DEFAULT_SCAN_EXCLUDE_DIRS: readonly string[] = [
  'node_modules',
  'dist',
  'build',
  '.semgrep',
  'coverage',
  '__tests__',
  'fixtures',
  '__fixtures__',
  '__mocks__',
] as const;

/**
 * 把默认排除目录追加为 `--exclude <dir>` 参数（semgrep 等 CLI 的通用形式）。
 *
 * **为什么连"追加动作"也共享**：只共享清单不够 —— 两个适配器各自写一遍
 * `for (const excl of LIST) args.push('--exclude', excl)`，仍是重复代码，
 * 而重复的代价正是本次事故的成因（security 侧那份是"漏写"，不是"写错"）。
 * 清单与用法绑在一个函数里，改一处即两处生效。
 */
export function appendScanExcludeArgs(args: string[]): string[] {
  for (const excl of DEFAULT_SCAN_EXCLUDE_DIRS) {
    args.push('--exclude', excl);
  }
  return args;
}
