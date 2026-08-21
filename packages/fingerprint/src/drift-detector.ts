// 漂移检测层（架构文档 §8）：轻量重探测 + stale 标记
// 检测项目结构变化，标记画像是否过期

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ProjectProfile } from './types';

// ─── 常量 ───

/** 需要监控 mtime 的关键文件（轻量重探测） */
const WATCHED_FILES = [
  'package.json',
  'pyproject.toml',
  'requirements.txt',
  'pom.xml',
  'go.mod',
  'Cargo.toml',
  'composer.json',
  'Gemfile',
  'tsconfig.json',
  'vue.config.js',
  'vite.config.ts',
  'next.config.js',
  'nest-cli.json',
  'project.config.json',
  'tauri.conf.json',
  'Podfile',
  'build.gradle',
  'android/AndroidManifest.xml',
] as const;

/** 漂移检测结果 */
export interface DriftResult {
  /** 是否检测到漂移 */
  readonly hasDrift: boolean;
  /** 发生变化的文件列表 */
  readonly changedFiles: readonly string[];
  /** 新增的文件列表 */
  readonly addedFiles: readonly string[];
  /** 删除的文件列表 */
  readonly removedFiles: readonly string[];
  /** 建议操作 */
  readonly recommendation: DriftRecommendation;
}

/** 漂移检测建议 */
export type DriftRecommendation =
  | { readonly type: 'no-action' }
  | { readonly type: 're-confirm'; readonly reason: string }
  | { readonly type: 'full-re-scan'; readonly reason: string };

// ─── DriftDetector 类 ───

export class DriftDetector {
  private readonly projectPath: string;

  constructor(projectPath: string) {
    this.projectPath = projectPath;
  }

  /**
   * 执行轻量漂移检测
   * @param existingProfile 已固化的画像（可选）
   * @returns DriftResult
   */
  detect(existingProfile?: ProjectProfile): DriftResult {
    // 如果无已有画像，建议完整扫描
    if (existingProfile === undefined) {
      return {
        hasDrift: true,
        changedFiles: [],
        addedFiles: [],
        removedFiles: [],
        recommendation: { type: 'full-re-scan', reason: 'no-existing-profile' },
      };
    }

    // 轻量重探测：检查关键文件 mtime
    const currentManifests = this.scanManifests();
    const storedManifests = this.extractStoredManifests(existingProfile);

    // 比较差异
    const changedFiles: string[] = [];
    const addedFiles: string[] = [];
    const removedFiles: string[] = [];

    // 检查变化和新增
    for (const [file, mtime] of currentManifests) {
      const storedMtime = storedManifests.get(file);
      if (storedMtime === undefined) {
        addedFiles.push(file);
      } else if (storedMtime !== 0 && mtime !== storedMtime) {
        changedFiles.push(file);
      }
    }

    // 检查删除
    for (const [file] of storedManifests) {
      if (!currentManifests.has(file)) {
        removedFiles.push(file);
      }
    }

    // 判断是否有漂移
    const hasDrift = changedFiles.length > 0 || addedFiles.length > 0 || removedFiles.length > 0;

    // 生成建议
    const recommendation = this.generateRecommendation(
      hasDrift,
      changedFiles,
      addedFiles,
      removedFiles,
      existingProfile,
    );

    return {
      hasDrift,
      changedFiles,
      addedFiles,
      removedFiles,
      recommendation,
    };
  }

  /**
   * 更新画像的漂移标记
   * @param profile 项目画像
   * @param driftResult 漂移检测结果
   * @returns 更新后的画像（stale 字段已更新）
   */
  markStale(profile: ProjectProfile, driftResult: DriftResult): ProjectProfile {
    if (!driftResult.hasDrift) {
      return profile;
    }

    return {
      ...profile,
      stale: true,
    };
  }

  // ─── 内部方法 ───

  /** 扫描关键文件的 mtime */
  private scanManifests(): Map<string, number> {
    const manifests = new Map<string, number>();

    for (const file of WATCHED_FILES) {
      const filePath = path.join(this.projectPath, file);
      try {
        const stat = fs.statSync(filePath);
        manifests.set(file, stat.mtimeMs);
      } catch {
        // 文件不存在，跳过
      }
    }

    return manifests;
  }

  /** 从已有画像中提取 manifest mtime 信息 */
  private extractStoredManifests(profile: ProjectProfile): Map<string, number> {
    const manifests = new Map<string, number>();

    for (const signal of profile.signals) {
      if (signal.kind === 'manifest' || signal.kind === 'config') {
        const payload = signal.payload as Record<string, unknown>;
        const mtime = typeof payload.mtime === 'number' ? payload.mtime : 0;
        manifests.set(signal.file, mtime);
      }
    }

    return manifests;
  }

  /** 生成漂移检测建议 */
  private generateRecommendation(
    hasDrift: boolean,
    changedFiles: readonly string[],
    addedFiles: readonly string[],
    removedFiles: readonly string[],
    _existingProfile: ProjectProfile,
  ): DriftRecommendation {
    if (!hasDrift) {
      return { type: 'no-action' };
    }

    // 关键文件变化（package.json, tsconfig.json 等）→ 建议重新确认
    const criticalFiles = ['package.json', 'tsconfig.json', 'pyproject.toml', 'pom.xml', 'go.mod'];
    const hasCriticalChange = changedFiles.some((f) => criticalFiles.includes(f)) ||
      addedFiles.some((f) => criticalFiles.includes(f)) ||
      removedFiles.some((f) => criticalFiles.includes(f));

    if (hasCriticalChange) {
      return {
        type: 're-confirm',
        reason: `critical-files-changed: ${[...changedFiles, ...addedFiles, ...removedFiles].join(', ')}`,
      };
    }

    // 非关键文件变化 → 建议轻量重新确认
    return {
      type: 're-confirm',
      reason: `manifest-changed: ${[...changedFiles, ...addedFiles, ...removedFiles].join(', ')}`,
    };
  }
}

// ─── 导出工厂函数 ───

/**
 * 创建 DriftDetector 实例
 * @param projectPath 项目根路径
 */
export function createDriftDetector(projectPath: string): DriftDetector {
  return new DriftDetector(projectPath);
}
