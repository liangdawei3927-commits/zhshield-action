/**
 * 摇树优化与代码分割检测器（tree-shaking-detector.ts）
 *
 * 纯静态分析前端性能的两个维度：
 * - tree-shaking：sideEffects 声明缺失 / 显式关闭 / 源码全量引入大体积库
 * - chunk-splitting：产物目录内超大 chunk / 单一 bundle 且依赖众多（缺代码分割）
 *
 * 零网络请求、绝不执行项目代码；任何文件缺失 / 解析失败均按静默跳过处理，
 * 检测过程绝不抛异常。
 */
import * as fs from 'fs';
import * as path from 'path';
import { safeJoin } from '@zh/shared';
import { DEFAULT_CONFIG, type PerformanceConfig, type PerformanceIssue } from '../types';

/** 已知体积较大的第三方库（全量引入会显著增大产物 / 阻塞摇树） */
export const KNOWN_LARGE_PACKAGES: ReadonlySet<string> = new Set([
  'lodash',
  'moment',
  'rxjs',
  'three',
  'echarts',
  'antd',
  '@mui/material',
  'react-router-dom',
  'dayjs',
  'd3',
  'axios',
  'framer-motion',
]);

/** 大 chunk 告警阈值（字节，默认 1MB）；导出便于测试注入 */
export const LARGE_CHUNK_THRESHOLD = 1024 * 1024;

/** 产物目录约定（与 bundle-size 检测器一致） */
const ARTIFACT_DIRS: readonly string[] = ['dist', 'build', 'out'];

/** 源码目录约定 */
const SOURCE_DIRS: readonly string[] = ['src'];

/** 源码文件扩展名（ts/tsx/js/jsx） */
const SOURCE_EXTS: readonly string[] = ['.ts', '.tsx', '.js', '.jsx'];

/** 摇树优化与代码分割检测器契约：离线静态，不联网 */
export interface TreeShakingDetector {
  detect(projectRoot: string, config?: PerformanceConfig): PerformanceIssue[];
}

/** 判断值是否为普通对象（非 null、非数组） */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 安全读取 JSON 文件；解析失败返回 null */
function readJsonSafe(filePath: string): Record<string, unknown> | null {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return isRecord(data) ? data : null;
  } catch {
    return null;
  }
}

/** 安全读取文本文件；读取失败返回 null */
function readTextSafe(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/** 将字节数格式化为人类可读体积，如 2097152 → '2 MB' */
export function formatBytes(bytes: number): string {
  const units: ReadonlyArray<[number, string]> = [
    [1024 * 1024 * 1024, 'GB'],
    [1024 * 1024, 'MB'],
    [1024, 'KB'],
  ];
  for (const [factor, unit] of units) {
    if (bytes >= factor) {
      const value = bytes / factor;
      return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
    }
  }
  return `${bytes} B`;
}

/** 摇树优化与代码分割检测器具体实现：离线静态，绝不抛异常 */
export class TreeShakingDetectorImpl implements TreeShakingDetector {
  detect(projectRoot: string, config?: PerformanceConfig): PerformanceIssue[] {
    const cfg: PerformanceConfig = { ...DEFAULT_CONFIG, ...(config ?? {}) };
    const issues: PerformanceIssue[] = [];
    const pkg = readJsonSafe(safeJoin(projectRoot, 'package.json'));
    const srcRoot = safeJoin(projectRoot, SOURCE_DIRS[0]);
    if (pkg) {
      this.collectTreeShakingIssues(projectRoot, pkg, srcRoot, cfg, issues);
    }
    const chunkFiles = this.collectArtifactChunks(projectRoot);
    this.collectChunkIssues(chunkFiles, cfg, issues);
    if (pkg) {
      this.collectNoCodeSplitIssue(pkg, chunkFiles, issues);
    }
    return sortTreeShakingIssues(issues);
  }

  /** tree-shaking 维度：sideEffects 缺失/显式关闭 + 大库全量引入 */
  private collectTreeShakingIssues(
    projectRoot: string,
    pkg: Record<string, unknown>,
    srcRoot: string,
    cfg: PerformanceConfig,
    issues: PerformanceIssue[],
  ): void {
    const isNpmPackage =
      typeof pkg.name === 'string' &&
      typeof pkg.version === 'string' &&
      (typeof pkg.main === 'string' || isRecord(pkg.exports));
    const sideEffects = pkg.sideEffects;
    if (isNpmPackage && sideEffects === undefined) {
      issues.push({
        id: 'tree-shaking-side-effects-missing',
        ruleId: 'tree-shaking.side-effects-missing',
        category: 'tree-shaking',
        severity: 'low',
        file: 'package.json',
        message: 'package.json 未声明 sideEffects 字段 — 建议声明 sideEffects 以启用摇树优化',
        suggestion: '在 package.json 中添加 "sideEffects": false 或列出含副作用的文件白名单',
        autoFixable: false,
      });
    } else if (sideEffects === true) {
      issues.push({
        id: 'tree-shaking-side-effects-true',
        ruleId: 'tree-shaking.side-effects-true',
        category: 'tree-shaking',
        severity: 'high',
        file: 'package.json',
        message: 'package.json 将 sideEffects 显式设为 true — 彻底关闭摇树，全部模块均会被打包',
        suggestion: '改为 "sideEffects": false 或仅对真正有副作用的文件（如 polyfill、样式）列出白名单',
        autoFixable: false,
      });
    }
    const sourceFiles = this.collectFiles(srcRoot, SOURCE_EXTS, cfg.scanLimit);
    const wholeLibraryHits = this.findWholeLibraryImports(projectRoot, sourceFiles, cfg.scanLimit);
    for (const hit of wholeLibraryHits) {
      issues.push({
        id: `tree-shaking-whole-library-${hit.library}`,
        ruleId: 'tree-shaking.whole-library-import',
        category: 'tree-shaking',
        severity: 'medium',
        file: hit.file,
        message: `${hit.file} 全量引入 ${hit.library} — 建议改为按需引入（import { debounce } from "${hit.library}/es"）或改用更轻量的替代库`,
        suggestion: '改为子路径按需引入，或对 moment/dayjs 等改为 tree-shakable 的替代方案',
        autoFixable: false,
      });
    }
  }

  /** chunk-splitting 维度：超大 chunk 告警 */
  private collectChunkIssues(
    chunkFiles: Array<{ file: string; size: number }>,
    cfg: PerformanceConfig,
    issues: PerformanceIssue[],
  ): void {
    for (const chunk of chunkFiles) {
      if (chunk.size > cfg.largeChunkThresholdBytes) {
        issues.push({
          id: `chunk-splitting-large-${chunk.file}`,
          ruleId: 'chunk-splitting.large-chunk',
          category: 'chunk-splitting',
          severity: 'high',
          file: chunk.file,
          message: `${chunk.file} 体积 ${formatBytes(chunk.size)} — 建议拆分为多 chunk 并按需加载`,
          suggestion: '路由级懒加载 / 动态 import / 拆 vendor，避免单一超大 bundle',
          autoFixable: false,
        });
      }
    }
  }

  /** chunk-splitting 维度：单一 bundle 且依赖众多（缺代码分割） */
  private collectNoCodeSplitIssue(
    pkg: Record<string, unknown>,
    chunkFiles: Array<{ file: string; size: number }>,
    issues: PerformanceIssue[],
  ): void {
    const deps = pkg.dependencies;
    const depCount = isRecord(deps) ? Object.keys(deps).length : 0;
    if (chunkFiles.length === 1 && depCount >= 5) {
      issues.push({
        id: 'chunk-splitting-no-code-split',
        ruleId: 'chunk-splitting.no-code-split',
        category: 'chunk-splitting',
        severity: 'medium',
        file: chunkFiles[0].file,
        message: '检测到单一 bundle 且依赖超过 5 个 — 建议启用路由级代码分割',
        suggestion: '按路由懒加载页面，或按需拆分第三方依赖为独立 chunk',
        autoFixable: false,
      });
    }
  }

  /** 递归收集源码目录下的 ts/tsx/js/jsx 文件（受 scanLimit 约束） */
  private collectFiles(dir: string, exts: readonly string[], limit: number): string[] {
    const files: string[] = [];
    if (!fs.existsSync(dir)) return files;
    const visit = (current: string): void => {
      if (files.length >= limit) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        return;
      }
       for (const entry of entries) {
        if (entry.name === '.' || entry.name === '..') continue;
        if (files.length >= limit) return;
        const full = safeJoin(current, entry.name);
        if (entry.isDirectory()) {
          // 跳过 node_modules 与产物目录，避免误扫依赖自身源码
          if (entry.name === 'node_modules' || ARTIFACT_DIRS.includes(entry.name)) continue;
          visit(full);
        } else if (entry.isFile() && exts.includes(path.extname(entry.name))) {
          files.push(full);
        }
      }
    };
    visit(dir);
    return files;
  }

  /** 递归收集产物目录（dist/build/out）下的 JS chunk（排除 .map），返回相对路径与字节数 */
  private collectArtifactChunks(projectRoot: string): Array<{ file: string; size: number }> {
    const chunks: Array<{ file: string; size: number }> = [];
    const visit = (dir: string, prefix: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
       for (const entry of entries) {
        if (entry.name === '.' || entry.name === '..') continue;
        const full = safeJoin(dir, entry.name);
        if (entry.isDirectory()) {
          visit(full, safeJoin(prefix, entry.name));
        } else if (entry.isFile() && entry.name.endsWith('.js') && !entry.name.endsWith('.map')) {
          this.collectChunkFile(chunks, full, prefix, entry.name);
        }
      }
    };
    for (const dirName of ARTIFACT_DIRS) {
      const dir = safeJoin(projectRoot, dirName);
      if (fs.existsSync(dir)) visit(dir, dirName);
    }
    return chunks;
  }

  /** 记录单个 JS chunk 文件（排除 .map）的体积；文件不可读时静默跳过 */
  private collectChunkFile(
    chunks: Array<{ file: string; size: number }>,
    full: string,
    prefix: string,
    name: string,
  ): void {
    try {
      const size = fs.statSync(full).size;
      chunks.push({ file: safeJoin(prefix, name).split(path.sep).join('/'), size });
    } catch {
      // 文件不可读时跳过
    }
  }

  /** 统计每个文件对已知大库的全量引入（排除子路径引入），按 (file, library) 去重 */
  private findWholeLibraryImports(projectRoot: string, files: string[], limit: number): Array<{ file: string; library: string }> {
    const hits: Array<{ file: string; library: string }> = [];
    const seen = new Set<string>();
    let scanned = 0;
    for (const filePath of files) {
      if (scanned >= limit) break;
      scanned++;
      const content = readTextSafe(filePath);
      if (content === null) continue;
      // 匹配 import ... from 'xxx' / "xxx" 或 require('xxx')
      for (const m of content.matchAll(/(?:import\s+(?:[\w\s*,{}$_]+)\s+from\s+|require\(\s*)['"]([^'"]+)['"]/g)) {
        this.recordWholeLibraryHit(hits, seen, projectRoot, filePath, m[1]);
      }
    }
    return hits;
  }

  /** 记录单个 specifier 对已知大库的全量引入（排除子路径引入），按 (file, library) 去重 */
  private recordWholeLibraryHit(
    hits: Array<{ file: string; library: string }>,
    seen: Set<string>,
    projectRoot: string,
    filePath: string,
    specifier: string,
  ): void {
    for (const lib of KNOWN_LARGE_PACKAGES) {
      // 仅全量引入（包名精确匹配），子路径如 'lodash/debounce' 不命中
      if (specifier !== lib) continue;
      const key = `${filePath}\u0000${lib}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const rel = path.relative(projectRoot, filePath).split(path.sep).join('/');
      hits.push({ file: rel, library: lib });
    }
  }
}

/** 便捷入口：单例类实例 */
export const treeShakingDetector: TreeShakingDetector = new TreeShakingDetectorImpl();

/** 排序：严重度降序，其次文件路径升序 */
function sortTreeShakingIssues(issues: PerformanceIssue[]): PerformanceIssue[] {
  const severityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  issues.sort((a, b) => {
    const sa = severityOrder[a.severity] ?? 5;
    const sb = severityOrder[b.severity] ?? 5;
    if (sa !== sb) return sa - sb;
    return a.file.localeCompare(b.file);
  });
  return issues;
}
