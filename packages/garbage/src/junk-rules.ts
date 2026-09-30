/**
 * 垃圾判定规则（纯数据 + 纯函数，不依赖 node 内建模块）。
 *
 * 单独成模块是为了让删除授权策略 deletable.ts 保持无 node 依赖：渲染进程需要
 * 复用同一套"什么可删"口径，若经 fs-detector 取规则会连带引入 node:fs 而无法打包。
 */

/** 可证明再生成的目录名：构建产物，整棵子树都由构建重新产出 */
export const REGENERABLE_DIRS: ReadonlySet<string> = new Set([
  'dist',
  'build',
  '.next',
  'coverage',
  '.turbo',
  '.cache',
  'release',
  'dist-electron',
]);

const JUNK_NAMES: ReadonlySet<string> = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
const JUNK_EXTS: readonly string[] = ['.log', '.tmp', '.bak', '.swp', '.swo'];
const JUNK_PREFIXES: readonly string[] = ['npm-debug.log', 'yarn-error.log', 'pnpm-debug.log'];

export const EMPTY_FILE_PATTERN = /^(index|main|app)\./i;

/** 系统残留 / 临时文件 / 备份文件 —— 检测与删除授权共用的唯一定义 */
export function isJunkFileName(name: string): boolean {
  if (JUNK_NAMES.has(name)) return true;
  if (JUNK_EXTS.some((ext) => name.endsWith(ext))) return true;
  if (JUNK_PREFIXES.some((prefix) => name.startsWith(prefix))) return true;
  return name.endsWith('~');
}

/** 路径任一段落在可再生目录内即视为产物路径 */
export function isRegenerablePath(relativePath: string): boolean {
  return relativePath
    .split('/')
    .filter((segment) => segment.length > 0)
    .some((segment) => REGENERABLE_DIRS.has(segment));
}
