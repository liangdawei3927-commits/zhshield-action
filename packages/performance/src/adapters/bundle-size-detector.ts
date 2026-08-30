/**
 * 包体积检测器（bundle-size-detector.ts）
 *
 * 纯静态分析前端构建产物（dist / build / out）的文件体积：
 * - 单文件超过阈值 → 大文件问题（500KB~1MB medium，>1MB high）
 * - 产物总量超过 5MB → 总量提示（low，建议评估分包策略）
 *
 * 零网络请求、不执行任何代码；目录不存在 / 扫描超限时静默跳过，绝不抛异常。
 */
import * as fs from 'fs';
import * as path from 'path';
import { safeJoin } from '@zh/shared';
import { DEFAULT_CONFIG, type PerformanceConfig, type PerformanceIssue } from '../types';

/** 产物根目录候选名（前端构建常见输出目录） */
const ARTIFACT_DIR_NAMES = ['dist', 'build', 'out'] as const;

/** 需跳过的目录名（依赖 / VCS / 构建缓存） */
const SKIP_DIR_NAMES = new Set(['node_modules', '.git', '.vite', '.cache']);

/** 需跳过的文件名模式（sourcemap / 系统文件 / 许可证） */
const SKIP_FILE_RE = /\.map$|^\.DS_Store$|\.LICENSE\.txt$/;

/** 产物总量告警阈值（字节，5MB） */
const TOTAL_ARTIFACT_WARN_BYTES = 5 * 1024 * 1024;

/** 包体积检测器契约：离线静态分析产物体积 */
export interface BundleSizeDetector {
  detect(projectRoot: string, config?: PerformanceConfig): PerformanceIssue[];
}

/** 字节 → 人类可读大小（KB/MB，保留 1 位小数） */
export function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  const kb = bytes / 1024;
  return `${kb.toFixed(1)} KB`;
}

/** 严重度权重（用于排序：高 > 中 > 低 > info） */
const SEVERITY_WEIGHT: Record<PerformanceIssue['severity'], number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

/** 包体积检测器具体实现：纯静态，绝不抛异常 */
export class BundleSizeDetectorImpl implements BundleSizeDetector {
  detect(projectRoot: string, config?: PerformanceConfig): PerformanceIssue[] {
    const cfg: PerformanceConfig = { ...DEFAULT_CONFIG, ...config };
    if (!cfg.analyzeArtifacts) return [];

    const state: { scanned: number; totalBytes: number; seq: number } = { scanned: 0, totalBytes: 0, seq: 0 };
    const issues: PerformanceIssue[] = [];
    for (const dirName of ARTIFACT_DIR_NAMES) {
      if (state.scanned >= cfg.scanLimit) break;
      const root = safeJoin(projectRoot, dirName);
      if (!fs.existsSync(root)) continue;
      this.walk(root, projectRoot, cfg, issues, state);
    }
    pushTotalWarning(state, issues);
    return sortBundleIssues(issues);
  }

  /** 递归遍历产物目录（受 scanLimit 约束），累计体积并收集大文件问题 */
  private walk(
    dir: string,
    projectRoot: string,
    cfg: PerformanceConfig,
    issues: PerformanceIssue[],
    state: { scanned: number; totalBytes: number; seq: number },
  ): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..') continue;
      if (state.scanned >= cfg.scanLimit) return;
      const fullPath = safeJoin(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) continue;
        this.walk(fullPath, projectRoot, cfg, issues, state);
        continue;
      }
      if (!entry.isFile()) continue;
      if (SKIP_FILE_RE.test(entry.name)) continue;
      this.collectFileSize(entry, fullPath, projectRoot, cfg, issues, state);
    }
  }

  /** 统计单文件体积并收集大文件问题 */
  private collectFileSize(
    entry: fs.Dirent,
    fullPath: string,
    projectRoot: string,
    cfg: PerformanceConfig,
    issues: PerformanceIssue[],
    state: { scanned: number; totalBytes: number; seq: number },
  ): void {
    state.scanned += 1;
    let size: number;
    try {
      size = fs.statSync(fullPath).size;
    } catch {
      return;
    }
    state.totalBytes += size;
    if (size > cfg.largeFileThresholdBytes) {
      const rel = path.relative(projectRoot, fullPath);
      const severity = size > cfg.largeChunkThresholdBytes ? 'high' : 'medium';
      issues.push({
        id: `bundle-size-${state.seq++}`,
        ruleId: 'bundle-size.large-file',
        category: 'bundle-size',
        severity,
        file: rel,
        message: `${rel} 体积 ${formatBytes(size)}，超过阈值 ${formatBytes(cfg.largeFileThresholdBytes)}`,
        suggestion: '建议开启代码分割 / 懒加载 / tree-shaking / 压缩，减小单文件体积',
        autoFixable: false,
      });
    }
  }
}

/** 产物总量告警（低优先级，单独规则） */
function pushTotalWarning(state: { scanned: number; totalBytes: number; seq: number }, issues: PerformanceIssue[]): void {
  if (state.totalBytes > TOTAL_ARTIFACT_WARN_BYTES) {
    issues.push({
      id: `bundle-size-${state.seq++}`,
      ruleId: 'bundle-size.total-artifacts',
      category: 'bundle-size',
      severity: 'low',
      file: '',
      message: `产物总大小 ${formatBytes(state.totalBytes)} — 建议评估分包策略`,
      suggestion: '建议评估分包策略：按路由 / 页面拆分产物，减小首屏加载体积',
      autoFixable: false,
    });
  }
}

/** 排序：严重度降序，其次文件路径升序 */
function sortBundleIssues(issues: PerformanceIssue[]): PerformanceIssue[] {
  return issues.sort((a, b) => {
    const bySeverity = SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity];
    if (bySeverity !== 0) return bySeverity;
    return a.file.localeCompare(b.file);
  });
}

/** 便捷入口 */
export const bundleSizeDetector: BundleSizeDetector = new BundleSizeDetectorImpl();
