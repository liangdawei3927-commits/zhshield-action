// ExtStatDetector 单测：扩展名统计（数量与占比），跳过噪声目录。

import { describe, expect, it } from 'vitest';
import type { Signal } from '../types';
import { ExtStatDetector } from '../detectors/ext-stat-detector';
import { isRecord } from '../fs-utils';
import { makeTempProject, cleanupTempProject } from './helpers';

const detector = new ExtStatDetector();

function statPayload(signals: readonly Signal[], ruleId: string): { count: number; ratio: number } {
  const signal = signals.find((s) => s.ruleId === ruleId);
  if (signal === undefined) throw new Error(`missing signal: ${ruleId}`);
  const payload = signal.payload;
  if (!isRecord(payload) || typeof payload.count !== 'number' || typeof payload.ratio !== 'number') {
    throw new Error(`invalid payload for ${ruleId}`);
  }
  return { count: payload.count, ratio: payload.ratio };
}

describe('ExtStatDetector', () => {
  it('GIVEN 3 个 .ts 与 1 个 .py WHEN detect THEN 产出各自数量与占比（0.75 / 0.25）', async () => {
    const root = makeTempProject({
      'a.ts': 'export {}',
      'b.ts': 'export {}',
      'c.ts': 'export {}',
      'main.py': 'print(1)',
    });
    try {
      const signals = await detector.detect(root);

      expect(statPayload(signals, 'ext-stat:typescript')).toEqual({ count: 3, ratio: 0.75 });
      expect(statPayload(signals, 'ext-stat:python')).toEqual({ count: 1, ratio: 0.25 });
      expect(signals.every((s) => s.kind === 'ext-stat')).toBe(true);
      expect(signals.every((s) => s.weight === 0.6)).toBe(true);
    } finally {
      cleanupTempProject(root);
    }
  });

  it('GIVEN node_modules/vendor/.venv 内含源码 WHEN detect THEN 噪声目录不参与统计', async () => {
    const root = makeTempProject({
      'main.ts': 'export {}',
      'node_modules/pkg/index.ts': 'export {}',
      'vendor/dep.py': 'print(1)',
      '.venv/lib/site.py': 'print(2)',
    });
    try {
      const signals = await detector.detect(root);

      expect(statPayload(signals, 'ext-stat:typescript')).toEqual({ count: 1, ratio: 1 });
      expect(signals.find((s) => s.ruleId === 'ext-stat:python')).toBeUndefined();
    } finally {
      cleanupTempProject(root);
    }
  });

  it('GIVEN 深层目录分布 WHEN detect THEN payload.byDir 按目录聚合（供 Profiler scope 归并）', async () => {
    const root = makeTempProject({
      'web/a.ts': 'export {}',
      'web/b.ts': 'export {}',
      'server/main.go': 'package main',
    });
    try {
      const signals = await detector.detect(root);
      const ts = signalByRuleId(signals, 'ext-stat:typescript');
      const go = signalByRuleId(signals, 'ext-stat:go');

      const tsPayload = ts.payload;
      expect(isRecord(tsPayload)).toBe(true);
      if (isRecord(tsPayload)) {
        expect(tsPayload.byDir).toEqual({ web: 2 });
      }
      const goPayload = go.payload;
      expect(isRecord(goPayload)).toBe(true);
      if (isRecord(goPayload)) {
        expect(goPayload.byDir).toEqual({ server: 1 });
      }
    } finally {
      cleanupTempProject(root);
    }
  });

  it('GIVEN 无可统计源码（仅文档/无扩展名文件）WHEN detect THEN 不产出任何信号', async () => {
    const root = makeTempProject({
      'README.md': '# demo',
      'LICENSE': 'MIT',
    });
    try {
      const signals = await detector.detect(root);
      expect(signals).toEqual([]);
    } finally {
      cleanupTempProject(root);
    }
  });
});

function signalByRuleId(signals: readonly Signal[], ruleId: string): Signal {
  const signal = signals.find((s) => s.ruleId === ruleId);
  if (signal === undefined) throw new Error(`missing signal: ${ruleId}`);
  return signal;
}
