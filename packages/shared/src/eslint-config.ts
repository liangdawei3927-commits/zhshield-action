/**
 * ESLint 配置探测模块
 *
 * guard 与 inspect 两个适配器原先各自复制了一份「寻找 ESLint 配置目录」
 * 的逻辑（ESLINT_CONFIG_NAMES / hasEslintConfig / resolveEslintTargetDir），
 * 去重后统一收敛到 @zh/shared，两包共享同一实现。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** ESLint 配置文件候选名（v8 .eslintrc* 与 v9 eslint.config.* 均覆盖） */
const ESLINT_CONFIG_NAMES = [
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  '.eslintrc',
] as const;

/** 判断目录是否包含 ESLint 配置文件 */
export function hasEslintConfig(dir: string): boolean {
  return ESLINT_CONFIG_NAMES.some((name) => fs.existsSync(path.join(dir, name)));
}

/**
 * 探测 ESLint 应扫描的目录：
 * 1. 项目根含 eslint 配置 → 项目根
 * 2. 一层子目录含 eslint 配置（嵌套仓库）→ 该子目录
 * 3. 有 src / packages → 对应源码目录
 * 4. 兜底项目根
 */
export function resolveEslintTargetDir(projectPath: string): string {
  if (hasEslintConfig(projectPath)) return projectPath;

  const entries = fs.existsSync(projectPath) ? fs.readdirSync(projectPath) : [];
  for (const entry of entries) {
    if (entry === 'node_modules') continue;
    const child = path.join(projectPath, entry);
    try {
      if (fs.statSync(child).isDirectory() && hasEslintConfig(child)) return child;
    } catch {
      // 忽略损坏的符号链接 / 无权限目录
    }
  }

  for (const candidate of ['src', 'packages']) {
    const dir = path.join(projectPath, candidate);
    if (fs.existsSync(dir)) return dir;
  }
  return projectPath;
}
