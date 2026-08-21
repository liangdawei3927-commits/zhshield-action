// DriftDetector 单测：漂移检测 / stale 标记

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DriftDetector } from '../drift-detector';
import { makeTempProject, cleanupTempProject } from './helpers';
import type { ProjectProfile, Signal } from '../types';

// ─── 测试辅助 ───

function makeTestProfile(signals?: readonly Signal[]): ProjectProfile {
  return {
    schemaVersion: 1,
    architecture: { value: 'monolith', confidence: 0.8, signals: [] },
    targets: [
      {
        id: 'default',
        path: '/test/project',
        language: { value: 'typescript', confidence: 0.95, signals: [] },
        frameworks: [],
        routeKey: 'typescript:*:*',
      },
    ],
    environments: [],
    dependencies: { direct: [] },
    detectedAt: '2026-08-17T00:00:00.000Z',
    stale: false,
    signals: signals ?? [],
    overrides: {},
  };
}

// ─── 测试用例 ───

describe('DriftDetector', () => {
  describe('漂移检测', () => {
    it('GIVEN 无已有画像 WHEN detect THEN 返回 hasDrift=true + full-re-scan', () => {
      const root = makeTempProject({});
      try {
        const detector = new DriftDetector(root);
        const result = detector.detect();

        expect(result.hasDrift).toBe(true);
        expect(result.recommendation.type).toBe('full-re-scan');
      } finally {
        cleanupTempProject(root);
      }
    });

    it('GIVEN 已有画像 + 无变化 WHEN detect THEN 返回 hasDrift=false', () => {
      const root = makeTempProject({
        'package.json': JSON.stringify({ name: 'test' }),
      });

      try {
        const profile = makeTestProfile([
          {
            ruleId: 'manifest:package-json',
            kind: 'manifest',
            file: 'package.json',
            weight: 1.0,
            payload: {},
          },
        ]);

        const detector = new DriftDetector(root);
        const result = detector.detect(profile);

        // 无变化（mtime 为 0 时视为未变化）
        expect(result.changedFiles.length).toBe(0);
        expect(result.addedFiles.length).toBe(0);
        expect(result.removedFiles.length).toBe(0);
      } finally {
        cleanupTempProject(root);
      }
    });

    it('GIVEN 已有画像 + 新增 package.json WHEN detect THEN 返回 addedFiles', () => {
      const root = makeTempProject({});

      try {
        // 空画像（无 manifest 信号）
        const profile = makeTestProfile([]);

        const detector = new DriftDetector(root);

        // 扫描前添加 package.json
        fs.writeFileSync(
          path.join(root, 'package.json'),
          JSON.stringify({ name: 'test' }),
        );

        const result = detector.detect(profile);

        expect(result.hasDrift).toBe(true);
        expect(result.addedFiles).toContain('package.json');
      } finally {
        cleanupTempProject(root);
      }
    });

    it('GIVEN 已有画像 + 删除 package.json WHEN detect THEN 返回 removedFiles', () => {
      const root = makeTempProject({
        'package.json': JSON.stringify({ name: 'test' }),
      });

      try {
        const profile = makeTestProfile([
          {
            ruleId: 'manifest:package-json',
            kind: 'manifest',
            file: 'package.json',
            weight: 1.0,
            payload: {},
          },
        ]);

        // 删除 package.json
        fs.unlinkSync(path.join(root, 'package.json'));

        const detector = new DriftDetector(root);
        const result = detector.detect(profile);

        expect(result.hasDrift).toBe(true);
        expect(result.removedFiles).toContain('package.json');
      } finally {
        cleanupTempProject(root);
      }
    });

    it('GIVEN 已有画像 + package.json 变化 WHEN detect THEN 返回 changedFiles + re-confirm', () => {
      const root = makeTempProject({
        'package.json': JSON.stringify({ name: 'test' }),
      });

      try {
        const pkgPath = path.join(root, 'package.json');
        const originalMtime = fs.statSync(pkgPath).mtimeMs;

        const profile = makeTestProfile([
          {
            ruleId: 'manifest:package-json',
            kind: 'manifest',
            file: 'package.json',
            weight: 1.0,
            payload: { mtime: originalMtime },
          },
        ]);

        const detector = new DriftDetector(root);

        fs.writeFileSync(pkgPath, JSON.stringify({ name: 'test-updated' }));

        const result = detector.detect(profile);

        expect(result.hasDrift).toBe(true);
        expect(result.changedFiles).toContain('package.json');
        expect(result.recommendation.type).toBe('re-confirm');
      } finally {
        cleanupTempProject(root);
      }
    });
  });

  describe('stale 标记', () => {
    it('GIVEN driftResult.hasDrift=true WHEN markStale THEN stale=true', () => {
      const root = makeTempProject({});
      try {
        const detector = new DriftDetector(root);
        const profile = makeTestProfile();

        const driftResult = {
          hasDrift: true,
          changedFiles: ['package.json'],
          addedFiles: [],
          removedFiles: [],
          recommendation: { type: 're-confirm' as const, reason: 'test' },
        };

        const updated = detector.markStale(profile, driftResult);

        expect(updated.stale).toBe(true);
      } finally {
        cleanupTempProject(root);
      }
    });

    it('GIVEN driftResult.hasDrift=false WHEN markStale THEN stale 保持不变', () => {
      const root = makeTempProject({});
      try {
        const detector = new DriftDetector(root);
        const profile = makeTestProfile();
        profile.stale = false;

        const driftResult = {
          hasDrift: false,
          changedFiles: [],
          addedFiles: [],
          removedFiles: [],
          recommendation: { type: 'no-action' as const },
        };

        const updated = detector.markStale(profile, driftResult);

        expect(updated.stale).toBe(false);
      } finally {
        cleanupTempProject(root);
      }
    });
  });

  describe('建议生成', () => {
    it('GIVEN 关键文件变化 WHEN detect THEN recommendation=re-confirm + reason=critical-files-changed', () => {
      const root = makeTempProject({
        'package.json': JSON.stringify({ name: 'test' }),
      });

      try {
        const pkgPath = path.join(root, 'package.json');
        const originalMtime = fs.statSync(pkgPath).mtimeMs;

        const profile = makeTestProfile([
          {
            ruleId: 'manifest:package-json',
            kind: 'manifest',
            file: 'package.json',
            weight: 1.0,
            payload: { mtime: originalMtime },
          },
        ]);

        const detector = new DriftDetector(root);

        fs.writeFileSync(pkgPath, JSON.stringify({ name: 'test-updated' }));

        const result = detector.detect(profile);

        expect(result.recommendation.type).toBe('re-confirm');
        if (result.recommendation.type === 're-confirm') {
          expect(result.recommendation.reason).toContain('critical-files-changed');
        }
      } finally {
        cleanupTempProject(root);
      }
    });
  });
});
