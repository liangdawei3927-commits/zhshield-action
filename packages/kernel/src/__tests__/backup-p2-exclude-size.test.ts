/**
 * P2-3 / P2-6 回归测试（实测报告 2026-10-27 第 3 批）：
 * - 备份默认排除治理产物目录（.zhshield/.omo），旧配置并集合并；
 * - 单次快照体积上限：打包前预估超限直接失败，不再静默写 1.5GB。
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackupConfigManager } from '../backup/config';
import {
  defaultBackupConfig,
  DEFAULT_GOVERNANCE_EXCLUDE_PATTERNS,
  DEFAULT_MAX_BACKUP_SIZE_MB,
} from '../backup/types';
import {
  matchesExcludePattern,
  estimateFilesTotalSize,
  backupSizeLimitError,
} from '../backup/utils';

describe('P2-3 备份默认排除治理目录', () => {
  it('defaultBackupConfig 本地与 GitHub 两侧都排除 .zhshield/.omo', () => {
    const def = defaultBackupConfig({ projectPath: '/tmp/x' });
    for (const patterns of [def.local.excludePatterns, def.github.excludePatterns]) {
      for (const gov of DEFAULT_GOVERNANCE_EXCLUDE_PATTERNS) {
        expect(patterns).toContain(gov);
      }
    }
  });

  it('matchesExcludePattern 命中任意深度的 .zhshield/.omo 条目', () => {
    const patterns = defaultBackupConfig().local.excludePatterns;
    expect(matchesExcludePattern('.zhshield/diagnostics/domains/inspect.json', patterns)).toBe(
      true,
    );
    expect(matchesExcludePattern('.omo/run-continuation/a.json', patterns)).toBe(true);
    expect(matchesExcludePattern('src/index.ts', patterns)).toBe(false);
  });

  it('旧配置文件（无治理目录）加载时并集注入，用户自有排除项保留', async () => {
    const project = mkdtempSync(join(tmpdir(), 'zh-p2-3-cfg-'));
    try {
      mkdirSync(join(project, '.zhshield'), { recursive: true });
      writeFileSync(
        join(project, '.zhshield', 'backup.yml'),
        [
          'backup:',
          '  local:',
          '    enabled: true',
          '    excludePatterns: ["build/", "*.log"]',
        ].join('\n'),
        'utf-8',
      );
      const config = await new BackupConfigManager().loadProjectConfig(project);
      expect(config.local.excludePatterns).toContain('build/');
      expect(config.local.excludePatterns).toContain('.zhshield/');
      expect(config.local.excludePatterns).toContain('.omo/');
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

describe('P2-6 备份体积上限', () => {
  it('defaultBackupConfig 携带 maxTotalSizeMB=512', () => {
    expect(defaultBackupConfig().local.maxTotalSizeMB).toBe(DEFAULT_MAX_BACKUP_SIZE_MB);
    expect(DEFAULT_MAX_BACKUP_SIZE_MB).toBe(512);
  });

  it('backupSizeLimitError：未超限返回 null，超限给出处置提示', () => {
    expect(backupSizeLimitError(100 * 1024 * 1024, 512)).toBeNull();
    expect(backupSizeLimitError(512 * 1024 * 1024, 512)).toBeNull(); // 等于上限不超
    const err = backupSizeLimitError(1.5 * 1024 ** 3, 512);
    expect(err).toContain('1.5GB');
    expect(err).toContain('512MB');
    expect(err).toContain('maxTotalSizeMB');
  });

  it('estimateFilesTotalSize：求和成功，stat 失败按 0 计', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zh-p2-6-size-'));
    try {
      const a = join(dir, 'a.txt');
      const b = join(dir, 'b.txt');
      writeFileSync(a, 'x'.repeat(1024));
      writeFileSync(b, 'y'.repeat(2048));
      const total = await estimateFilesTotalSize([a, b, join(dir, 'missing.txt')]);
      expect(total).toBe(3072);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
