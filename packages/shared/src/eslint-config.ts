/**
 * ESLint 配置探测模块
 *
 * guard 与 inspect 两个适配器原先各自复制了一份「寻找 ESLint 配置目录」
 * 的逻辑（ESLINT_CONFIG_NAMES / hasEslintConfig / resolveEslintTargetDir），
 * 去重后统一收敛到 @zh/shared，两包共享同一实现。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** ESLint 配置文件候选名（v8 .eslintrc* 与 v9 eslint.config.* 均覆盖，含 TS/YAML 变体） */
export const ESLINT_CONFIG_NAMES = [
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
  'eslint.config.mts',
  'eslint.config.cts',
  'eslint.config.json',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.mjs',
  '.eslintrc.json',
  '.eslintrc.yml',
  '.eslintrc.yaml',
  '.eslintrc',
] as const;

/** 判断目录是否包含 ESLint 配置文件 */
export function hasEslintConfig(dir: string): boolean {
  return ESLINT_CONFIG_NAMES.some((name) => fs.existsSync(path.join(dir, name)));
}

/**
 * 在给定目录列表中探测首个含 ESLint 配置的目录。
 *
 * 用于「项目根本没配 ESLint」的判定：ESLint v9+ 在无 eslint.config.* 时
 * 直接以非零退出并打印 "couldn't find an eslint.config.(js|mjs|cjs) file"，
 * 若把这当成检查失败，用户会看到一条凭空的 error。返回 undefined 即表示
 * 该项目没有可用的 ESLint 配置 —— 调用方应跳过而非判失败。
 */
export function findEslintConfigDir(dirs: ReadonlyArray<string | undefined>): string | undefined {
  return dirs.find((dir): dir is string => !!dir && hasEslintConfig(dir));
}

/**
 * 返回目录下首个存在的 ESLint 配置文件绝对路径（flat config 优先，legacy 兜底）。
 *
 * 用于 `eslint --config <path>`：调用方需要的是「哪个文件」，而 hasEslintConfig
 * 只回答「有没有」。无配置时返回 undefined。
 */
export function resolveEslintConfigPath(dir: string): string | undefined {
  for (const name of ESLINT_CONFIG_NAMES) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return undefined;
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
