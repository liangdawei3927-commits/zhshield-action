import { randomUUID } from 'crypto';
import type { GarbageItem } from './types';
import type { Issue } from '@zh/shared';
import { dirSizeOf, scanGarbageDir } from '@zh/shared';

const IGNORE_DIRS = new Set(['node_modules', '.git']);

const NODE_MODULES_DIR = new Set(['node_modules']);

/** 可再生成的构建产物根目录（仅项目根级识别，嵌套同名目录不视为垃圾） */
const BUILD_ARTIFACT_DIRS = new Set([
  'dist',
  'build',
  '.next',
  'coverage',
  '.turbo',
  '.cache',
  'release',
  'dist-electron',
]);

const JUNK_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
const JUNK_EXTS = ['.log', '.tmp', '.bak', '.swp', '.swo'];
const JUNK_PREFIXES = ['npm-debug.log', 'yarn-error.log', 'pnpm-debug.log'];

export function mapDepcheckIssuesToGarbage(issues: Issue[]): GarbageItem[] {
  return issues
    .filter((i) => i.ruleId.includes('unused') || i.category === 'dependency')
    .map((i) => ({
      id: randomUUID(),
      type: 'unused-dependency' as const,
      path: i.file || i.message,
      size: 0,
      reason: i.message || `Unused dependency: ${i.ruleId}`,
    }));
}

/**
 * 扫描项目根层的构建产物目录与垃圾文件。
 *
 * 与 @zh/garbage 的 fs-detector 同一模式：目录遍历骨架已收敛到 @zh/shared 的
 * scanGarbageDir，本域只注入自身口径（忽略目录集 / 构建产物目录集 / 垃圾文件名
 * 规则 / 体积统计）。原 GarbageScanner 为无状态单方法薄壳类，按 lazy-class 建议
 * 内联为函数；保留 async 以维持原有的 Promise 返回契约。
 */
export async function scanGarbage(projectPath: string): Promise<GarbageItem[]> {
  return scanGarbageDir(projectPath, {
    ignoreDirs: IGNORE_DIRS,
    buildArtifactDirs: BUILD_ARTIFACT_DIRS,
    isJunkFileName: isJunkFile,
    measureDirSize: dirSize,
  });
}

/** 判断文件名是否为垃圾文件（系统残留 / 临时文件 / 备份文件） */
function isJunkFile(name: string): boolean {
  if (JUNK_NAMES.has(name)) return true;
  if (JUNK_EXTS.some((ext) => name.endsWith(ext))) return true;
  if (JUNK_PREFIXES.some((p) => name.startsWith(p))) return true;
  if (name.endsWith('~')) return true;
  return false;
}

/**
 * 递归统计目录体积。
 *
 * 忽略口径：仅在目录分支内跳过 node_modules（构建产物里嵌入依赖时递归进去既慢
 * 又可能踩符号链接环），代价是嵌套 node_modules 不计入体积 —— 属**少报**
 * （承诺可释放空间偏小），不会出现"承诺得多、实际释放得少"的虚报。
 */
function dirSize(dir: string): number {
  return dirSizeOf(dir, { ignoreNames: NODE_MODULES_DIR, dirsOnly: true });
}
