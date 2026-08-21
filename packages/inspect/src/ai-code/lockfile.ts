/**
 * 锁文件包名提取（lockfile.ts）
 *
 * 只读解析 pnpm-lock.yaml / package-lock.json / yarn.lock，提取"项目实际安装的
 * 包名集合"，作为幻觉依赖本地查证的锁定环。零网络（边界 3：registry 查证零外联）。
 */
import { readTextFileSafe } from './files';

/** 解析 pnpm-lock.yaml（v6+ 锁文件）：packages 条目形如 `  /lodash@4.17.21:` */
export function collectPnpmPackages(content: string): Set<string> {
  const names = new Set<string>();
  const re = /^ {2}\/((?:@[^/@\s]+\/)?[^@/\s]+)@\d/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const name = m[1];
    if (name !== undefined) names.add(name);
  }
  return names;
}

/** 解析 package-lock.json：v2/v3 走 packages 键，v1 走 dependencies 键 */
export function collectNpmPackages(content: string): Set<string> {
  const names = new Set<string>();
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    return names; // 锁文件损坏：视为无（边界 fallback）
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return names;
  const root = data as Record<string, unknown>;

  const packages = root['packages'];
  if (typeof packages === 'object' && packages !== null) {
    for (const key of Object.keys(packages as Record<string, unknown>)) {
      if (!key.startsWith('node_modules/')) continue;
      const idx = key.lastIndexOf('node_modules/');
      const name = key.slice(idx + 'node_modules/'.length);
      if (name === '') continue;
      if (name.startsWith('@')) names.add(name); // scoped：@scope/pkg 名称含 '/'，合法
      else if (!name.includes('/')) names.add(name);
    }
    return names;
  }

  const deps = root['dependencies'];
  if (typeof deps === 'object' && deps !== null) {
    for (const name of Object.keys(deps as Record<string, unknown>)) names.add(name);
  }
  return names;
}

/**
 * 解析 yarn.lock（v1 头部行；v2/v3 嵌套条目行同样以 名称@ 开头）。
 * 形如 `lodash@^4.17.21:` / `"@babel/core@^7.0.0":`
 */
export function collectYarnPackages(content: string): Set<string> {
  const names = new Set<string>();
  const re = /^"?((?:@[^/@\s]+\/)?[^@/\s]+)@/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const name = m[1];
    if (name !== undefined) names.add(name);
  }
  return names;
}

/** 聚合三种锁文件命中的包名集合；锁文件缺失/不可解析返回空集（不报"不存在"） */
export function collectLockfilePackages(projectPath: string): ReadonlySet<string> {
  const names = new Set<string>();
  const pnpm = readTextFileSafe(projectPath, 'pnpm-lock.yaml');
  if (pnpm !== null) for (const n of collectPnpmPackages(pnpm)) names.add(n);
  const npm = readTextFileSafe(projectPath, 'package-lock.json');
  if (npm !== null) for (const n of collectNpmPackages(npm)) names.add(n);
  const yarn = readTextFileSafe(projectPath, 'yarn.lock');
  if (yarn !== null) for (const n of collectYarnPackages(yarn)) names.add(n);
  return names;
}
