/**
 * 安全扫描的目录遍历约定（injection-guard / security-check-engine / malware-scanner 三处共用）。
 *
 * 排除生成目录与测试目录/夹具（刻意构造的攻击样本仅用于驱动规则测试，非生产代码），
 * 对齐 inspect 包 semgrep-adapter 的 excludePaths 约定（见 semgrep-adapter.ts）。
 */
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
