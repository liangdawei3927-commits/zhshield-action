/**
 * 安全扫描的目录遍历约定（injection-guard / security-check-engine / malware-scanner 三处共用）。
 *
 * 排除生成目录与测试目录/夹具（刻意构造的攻击样本仅用于驱动规则测试，非生产代码），
 * 对齐 inspect 包 semgrep-adapter 的 excludePaths 约定（见 semgrep-adapter.ts）。
 */
import { safeJoin, safeReadDirEntries } from '@zh/shared';


export const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'dist',
  'dist-electron',
  'build',
  'coverage',
  '.turbo',
  '.next',
  '.cache',
  'release',
  '.zhshield',
  '__tests__',
  'fixtures',
  '__fixtures__',
  '__mocks__',
]);

/** 遍历最大目录层级，防止病态深树拖垮扫描 */
export const MAX_SCAN_DEPTH = 12;

/** 依赖清单文件名（以精确文件名匹配，区别于源码的扩展名匹配） */
export const PACKAGE_JSON_FILE = 'package.json';

/** 遍历到文件时的回调：绝对路径 + 文件名（调用方按扩展名/文件名自行筛选） */
export type SourceFileVisitor = (fullPath: string, fileName: string) => void;

/**
 * 递归遍历源码树，对每个**非噪声目录**下的普通文件回调一次。
 *
 * 此前 injection-guard 与 malware-scanner 各写了一套同样的递归：判深度、
 * 跳过 SKIP_DIRS、目录递归、只处理普通文件。两处实现还悄悄分叉了 ——
 * malware-scanner 用 safeJoin/safeReadDirEntries，injection-guard 用
 * `fs.readdirSync` + `path.join`。统一到本函数后两处走同一套拼接与容错，
 * 后续新增扫描器也不必再抄第三份。
 *
 * 语义保持：无权限/不存在的目录静默跳过（fail-open），深度超过
 * {@link MAX_SCAN_DEPTH} 即停止下潜 —— 与两处原实现一致。
 */
export function walkSourceTree(dir: string, visitFile: SourceFileVisitor, depth = 0): void {
  if (depth > MAX_SCAN_DEPTH) return;
  for (const entry of safeReadDirEntries(dir)) {
    const fullPath = safeJoin(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkSourceTree(fullPath, visitFile, depth + 1);
      continue;
    }
    if (!entry.isFile()) continue;
    visitFile(fullPath, entry.name);
  }
}
