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
import * as fs from 'node:fs';
import * as path from 'node:path';

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
  // 工具自身的状态与备份目录：里面有历史快照、备份 zip、被恢复的整棵源码树。
  // 它们既不是待检源码，也不该进「源码树」扫描（2026-11-09 实测：被扫项目
  // `.zhshield/backups` 780MB、`build-output` 666MB，semgrep 走完超 120s 预算被强杀，
  // 安全域直接 unavailable —— 扫描范围把工具自己的备份也圈了进去）。
  '.zhshield',
  'build-output',
  // git 对象库：源码扫描工具按目录遍历时会连它一起走（真实源码在 .gitignore 之外）
  '.git',
] as const;

/**
 * 把默认排除目录追加为 `--exclude <dir>` 参数（semgrep 等 CLI 的通用形式）。
 *
 * **为什么连"追加动作"也共享**：只共享清单不够 —— 两个适配器各自写一遍
 * `for (const excl of LIST) args.push('--exclude', excl)`，仍是重复代码，
 * 而重复的代价正是本次事故的成因（security 侧那份是"漏写"，不是"写错"）。
 * 清单与用法绑在一个函数里，改一处即两处生效。
 *
 * @param projectPath 被扫项目根。传了会把「本项目的嵌套独立仓库」名加入排除：
 *   目标本身是仓库、子目录里又放着一份带 `.git` 的完整仓库（本仓的
 *   `ZHCodeShield/` ↔ `zhihui-codeshield/` 内外分离就是这种结构）时，
 *   按目录递归会把那份**别人的仓库**一起扫进去。2026-11-09 实测：扫文档仓
 *   时 semgrep 纯遍历内层 1.5GB 仓库就耗了 94s，安全域 120s 预算被打满、进程被杀。
 *   按名字排除是工具侧唯一可用的手段（semgrep 的 --exclude 按目录名匹配）。
 */
export function appendScanExcludeArgs(args: string[], projectPath?: string): string[] {
  const excludes = new Set<string>(DEFAULT_SCAN_EXCLUDE_DIRS);
  if (projectPath) {
    for (const name of nestedRepoDirNames(projectPath)) excludes.add(name);
  }
  for (const excl of excludes) {
    args.push('--exclude', excl);
  }
  return args;
}

/** 列出项目根下一层子目录中的**独立仓库**名（带 `.git` 的子目录 = 另一个项目） */
function nestedRepoDirNames(projectPath: string): string[] {
  try {
    const names: string[] = [];
    for (const entry of fs.readdirSync(projectPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'node_modules') continue;
      if (fs.existsSync(path.join(projectPath, entry.name, '.git'))) names.push(entry.name);
    }
    return names;
  } catch {
    // 目录不可读：不追加任何动态排除（宁可多扫，也不能不扫）
    return [];
  }
}
