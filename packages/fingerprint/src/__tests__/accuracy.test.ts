// accuracy 模块单测：precision / recall / 宏平均 / 阈值判定 / loadGoldenDir
// Given / When / Then 格式（架构文档 §10.2）

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { evaluateAccuracy, loadGoldenDir } from '../accuracy';
import type { GoldenAssertion } from '../accuracy';

// ─── evaluateAccuracy ───

describe('evaluateAccuracy', () => {
  describe('完美匹配', () => {
    it('GIVEN 所有检测与断言完全匹配 WHEN evaluateAccuracy THEN precision=1 recall=1', () => {
      const assertions: readonly GoldenAssertion[] = [
        { path: 'src/main.ts', language: 'typescript' },
        { path: 'src/app.py', language: 'python' },
      ];
      const detected = [
        { file: 'src/main.ts', detectorId: 'manifest-detector', language: 'typescript' },
        { file: 'src/app.py', detectorId: 'manifest-detector', language: 'python' },
      ];

      const report = evaluateAccuracy(assertions, detected);

      expect(report.evaluations).toHaveLength(1);
      expect(report.evaluations[0].precision).toBe(1);
      expect(report.evaluations[0].recall).toBe(1);
      expect(report.evaluations[0].truePositives).toBe(2);
      expect(report.evaluations[0].falsePositives).toBe(0);
      expect(report.evaluations[0].falseNegatives).toBe(0);
      expect(report.overallPrecision).toBe(1);
      expect(report.overallRecall).toBe(1);
      expect(report.passesThresholds).toBe(true);
    });
  });

  describe('部分匹配', () => {
    it('GIVEN 部分检测匹配断言 WHEN evaluateAccuracy THEN 正确计算 TP/FP/FN/precision/recall', () => {
      const assertions: readonly GoldenAssertion[] = [
        { path: 'src/main.ts', language: 'typescript' },
        { path: 'src/app.py', language: 'python' },
        { path: 'src/util.go', language: 'go' },
      ];
      const detected = [
        { file: 'src/main.ts', detectorId: 'ext-stat-detector', language: 'typescript' },
        { file: 'src/app.py', detectorId: 'ext-stat-detector', language: 'python' },
        { file: 'src/fake.rs', detectorId: 'ext-stat-detector', language: 'rust' },
      ];

      const report = evaluateAccuracy(assertions, detected);

      // TP=2, FP=1 (fake.rs), FN=1 (util.go 未检测到)
      expect(report.evaluations[0].truePositives).toBe(2);
      expect(report.evaluations[0].falsePositives).toBe(1);
      expect(report.evaluations[0].falseNegatives).toBe(1);
      expect(report.evaluations[0].precision).toBeCloseTo(2 / 3);
      expect(report.evaluations[0].recall).toBeCloseTo(2 / 3);
    });

    it('GIVEN 多个探测器混合匹配 WHEN evaluateAccuracy THEN 按 detectorId 分组计算', () => {
      const assertions: readonly GoldenAssertion[] = [
        { path: 'a.ts', language: 'typescript' },
        { path: 'b.py', language: 'python' },
      ];
      const detected = [
        { file: 'a.ts', detectorId: 'manifest-detector', language: 'typescript' },
        { file: 'b.py', detectorId: 'manifest-detector', language: 'python' },
        { file: 'a.ts', detectorId: 'ext-stat-detector', language: 'typescript' },
        { file: 'c.rs', detectorId: 'ext-stat-detector', language: 'rust' },
      ];

      const report = evaluateAccuracy(assertions, detected);

      const manifestEval = report.evaluations.find((e) => e.detectorId === 'manifest-detector');
      const extStatEval = report.evaluations.find((e) => e.detectorId === 'ext-stat-detector');
      expect(manifestEval).toBeDefined();
      expect(extStatEval).toBeDefined();
      expect(manifestEval!.precision).toBe(1);
      expect(manifestEval!.recall).toBe(1);
      expect(extStatEval!.precision).toBeCloseTo(0.5);
      expect(extStatEval!.recall).toBeCloseTo(0.5);
    });
  });

  describe('空输入', () => {
    it('GIVEN 断言和检测均为空 WHEN evaluateAccuracy THEN 零值且 passesThresholds=true', () => {
      const report = evaluateAccuracy([], []);

      expect(report.evaluations).toHaveLength(0);
      expect(report.overallPrecision).toBe(0);
      expect(report.overallRecall).toBe(0);
      expect(report.passesThresholds).toBe(true);
    });

    it('GIVEN 断言为空但有检测 WHEN evaluateAccuracy THEN precision=0 recall=0', () => {
      const detected = [{ file: 'x.ts', detectorId: 'manifest-detector', language: 'typescript' }];

      const report = evaluateAccuracy([], detected);

      expect(report.evaluations[0].precision).toBe(0);
      expect(report.evaluations[0].recall).toBe(0);
    });
  });

  describe('passesThresholds 判定', () => {
    it('GIVEN 语言探测器 precision≥0.95 recall≥0.9 WHEN evaluateAccuracy THEN passesThresholds=true', () => {
      // 10 golden, 10 detected all matching → precision=1, recall=1
      const assertions: readonly GoldenAssertion[] = Array.from({ length: 10 }, (_, i) => ({
        path: `src/file${i}.ts`,
        language: 'typescript',
      }));
      const detected = assertions.map((a) => ({
        file: a.path,
        detectorId: 'manifest-detector',
        language: 'typescript' as const,
      }));

      const report = evaluateAccuracy(assertions, detected);
      expect(report.passesThresholds).toBe(true);
    });

    it('GIVEN 语言探测器 precision<0.95 WHEN evaluateAccuracy THEN passesThresholds=false', () => {
      // 2 golden, 10 detected → precision=2/10=0.2
      const assertions: readonly GoldenAssertion[] = [
        { path: 'a.ts', language: 'typescript' },
        { path: 'b.ts', language: 'typescript' },
      ];
      const detections = [
        { file: 'a.ts', detectorId: 'manifest-detector', language: 'typescript' },
        { file: 'b.ts', detectorId: 'manifest-detector', language: 'typescript' },
        ...Array.from({ length: 8 }, (_, i) => ({
          file: `fake${i}.rs`,
          detectorId: 'manifest-detector',
          language: 'rust',
        })),
      ];

      const report = evaluateAccuracy(assertions, detections);
      expect(report.passesThresholds).toBe(false);
    });

    it('GIVEN 语言探测器 recall<0.9 WHEN evaluateAccuracy THEN passesThresholds=false', () => {
      // 10 golden, 2 detected → recall=2/10=0.2
      const assertions: readonly GoldenAssertion[] = Array.from({ length: 10 }, (_, i) => ({
        path: `src/file${i}.ts`,
        language: 'typescript',
      }));
      const detected = [
        { file: 'src/file0.ts', detectorId: 'ext-stat-detector', language: 'typescript' },
        { file: 'src/file1.ts', detectorId: 'ext-stat-detector', language: 'typescript' },
      ];

      const report = evaluateAccuracy(assertions, detected);
      expect(report.passesThresholds).toBe(false);
    });

    it('GIVEN 形态探测器 precision<0.8 WHEN evaluateAccuracy THEN passesThresholds=false', () => {
      const assertions: readonly GoldenAssertion[] = [
        { path: 'ios/Podfile', productForm: 'ios' },
        { path: 'android/build.gradle', productForm: 'android' },
      ];
      // 2 TPs + 3 FPs → precision=2/5=0.4
      const detected = [
        { file: 'ios/Podfile', detectorId: 'form-detector', productForm: 'ios' },
        { file: 'android/build.gradle', detectorId: 'form-detector', productForm: 'android' },
        { file: 'x.ts', detectorId: 'form-detector' },
        { file: 'y.py', detectorId: 'form-detector' },
        { file: 'z.go', detectorId: 'form-detector' },
      ];

      const report = evaluateAccuracy(assertions, detected);
      expect(report.passesThresholds).toBe(false);
    });

    it('GIVEN 形态探测器 precision≥0.8 WHEN evaluateAccuracy THEN passesThresholds=true', () => {
      const assertions: readonly GoldenAssertion[] = [
        { path: 'ios/Podfile', productForm: 'ios' },
        { path: 'android/build.gradle', productForm: 'android' },
      ];
      // 2 TPs + 1 FP → precision=2/3≈0.667...
      // Actually need ≥0.8, so: 2 TPs + 0 FPs → precision=1
      const detected = [
        { file: 'ios/Podfile', detectorId: 'form-detector', productForm: 'ios' },
        { file: 'android/build.gradle', detectorId: 'form-detector', productForm: 'android' },
      ];

      const report = evaluateAccuracy(assertions, detected);
      expect(report.passesThresholds).toBe(true);
    });
  });

  describe('宏平均', () => {
    it('GIVEN 多个探测器 WHEN evaluateAccuracy THEN overall 为宏平均', () => {
      const assertions: readonly GoldenAssertion[] = [{ path: 'a.ts', language: 'typescript' }];
      const detected = [
        { file: 'a.ts', detectorId: 'manifest-detector', language: 'typescript' },
        { file: 'a.ts', detectorId: 'ext-stat-detector', language: 'typescript' },
        { file: 'b.py', detectorId: 'ext-stat-detector', language: 'python' },
      ];

      const report = evaluateAccuracy(assertions, detected);

      // manifest: P=1, R=1; ext-stat: P=0.5, R=1
      // 宏平均: P=(1+0.5)/2=0.75, R=(1+1)/2=1
      expect(report.overallPrecision).toBeCloseTo(0.75);
      expect(report.overallRecall).toBeCloseTo(1);
    });
  });

  describe('类型字段匹配', () => {
    it('GIVEN golden 带 framework WHEN 检测匹配 THEN 算 TP；不匹配 THEN 算 FP', () => {
      const assertions: readonly GoldenAssertion[] = [
        { path: 'package.json', language: 'typescript', framework: 'Next.js' },
      ];
      const detected = [
        {
          file: 'package.json',
          detectorId: 'manifest-detector',
          language: 'typescript',
          framework: 'Next.js',
        },
      ];

      const report = evaluateAccuracy(assertions, detected);
      expect(report.evaluations[0].truePositives).toBe(1);

      // framework 不匹配 → FP
      const detectedBad = [
        {
          file: 'package.json',
          detectorId: 'manifest-detector',
          language: 'typescript',
          framework: 'Vue',
        },
      ];
      const reportBad = evaluateAccuracy(assertions, detectedBad);
      expect(reportBad.evaluations[0].falsePositives).toBe(1);
    });
  });
});

// ─── loadGoldenDir ───

describe('loadGoldenDir', () => {
  it('GIVEN 子目录含 golden.json WHEN loadGoldenDir THEN 返回所有断言', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'golden-test-'));
    const fixtureDir = path.join(tmpDir, 'fixture-1');
    fs.mkdirSync(fixtureDir, { recursive: true });
    fs.writeFileSync(
      path.join(fixtureDir, 'golden.json'),
      JSON.stringify([
        { path: 'src/main.ts', language: 'typescript' },
        { path: 'src/app.py', language: 'python' },
      ]),
    );

    try {
      const assertions = loadGoldenDir(tmpDir);
      expect(assertions).toHaveLength(2);
      expect(assertions[0].language).toBe('typescript');
      expect(assertions[1].language).toBe('python');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('GIVEN 多个子目录各有 golden.json WHEN loadGoldenDir THEN 聚合所有断言', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'golden-test-'));

    for (const [name, data] of [
      ['ts-fixture', [{ path: 'a.ts', language: 'typescript' }]],
      ['py-fixture', [{ path: 'b.py', language: 'python' }]],
    ] as const) {
      const dir = path.join(tmpDir, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'golden.json'), JSON.stringify(data));
    }

    try {
      const assertions = loadGoldenDir(tmpDir);
      expect(assertions).toHaveLength(2);
      const languages = assertions.map((a) => a.language);
      expect(languages).toContain('typescript');
      expect(languages).toContain('python');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('GIVEN 无 golden.json 子目录 WHEN loadGoldenDir THEN 返回空数组', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'golden-test-'));
    fs.mkdirSync(path.join(tmpDir, 'empty-fixture'), { recursive: true });

    try {
      const assertions = loadGoldenDir(tmpDir);
      expect(assertions).toHaveLength(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
