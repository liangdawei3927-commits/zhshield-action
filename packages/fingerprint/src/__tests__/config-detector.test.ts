// ConfigDetector 单测：配置文件 → 语言/框架/环境信号。

import { describe, expect, it } from 'vitest';
import type { Signal } from '../types';
import { ConfigDetector } from '../detectors/config-detector';
import { isRecord } from '../fs-utils';
import { makeTempProject, cleanupTempProject } from './helpers';

const detector = new ConfigDetector();

function signalByRuleId(signals: readonly Signal[], ruleId: string): Signal {
  const signal = signals.find((s) => s.ruleId === ruleId);
  if (signal === undefined) throw new Error(`missing signal: ${ruleId}`);
  return signal;
}

describe('ConfigDetector', () => {
  it('GIVEN 根 tsconfig.json WHEN detect THEN 产出 config:tsconfig 决定性 TS 信号（language=typescript, confidence 0.95）', async () => {
    const root = makeTempProject({
      'tsconfig.json': '{ "compilerOptions": { "strict": true } }',
    });
    try {
      const signals = await detector.detect(root);

      const tsconfig = signalByRuleId(signals, 'config:tsconfig');
      expect(tsconfig.kind).toBe('config');
      expect(tsconfig.weight).toBe(0.8);
      expect(tsconfig.file).toBe('tsconfig.json');
      const payload = tsconfig.payload;
      expect(isRecord(payload)).toBe(true);
      if (isRecord(payload)) {
        expect(payload.language).toBe('typescript');
        expect(payload.confidence).toBe(0.95);
      }
    } finally {
      cleanupTempProject(root);
    }
  });

  it('GIVEN vite.config.ts 与 vue.config.js WHEN detect THEN 产出 Vite 与 Vue 框架信号', async () => {
    const root = makeTempProject({
      'vite.config.ts': 'export default {}',
      'vue.config.js': 'module.exports = {}',
    });
    try {
      const signals = await detector.detect(root);

      expect(signalByRuleId(signals, 'config:vite').payload).toEqual(
        expect.objectContaining({ framework: 'Vite' }),
      );
      expect(signalByRuleId(signals, 'config:vue-config').payload).toEqual(
        expect.objectContaining({ framework: 'Vue' }),
      );
    } finally {
      cleanupTempProject(root);
    }
  });

  it('GIVEN .nvmrc 与 Dockerfile WHEN detect THEN 产出 node/docker 环境信号', async () => {
    const root = makeTempProject({
      '.nvmrc': '20',
      'Dockerfile': 'FROM node:20-alpine\n',
    });
    try {
      const signals = await detector.detect(root);

      expect(signalByRuleId(signals, 'config:node-version').payload).toEqual(
        expect.objectContaining({ environment: 'node' }),
      );
      expect(signalByRuleId(signals, 'config:docker').payload).toEqual(
        expect.objectContaining({ environment: 'docker' }),
      );
    } finally {
      cleanupTempProject(root);
    }
  });

  it('GIVEN 仅含无关文件 WHEN detect THEN 不产出任何 config 信号', async () => {
    const root = makeTempProject({
      'README.md': '# demo',
      'src/index.js': 'console.log(1)',
    });
    try {
      const signals = await detector.detect(root);
      expect(signals).toEqual([]);
    } finally {
      cleanupTempProject(root);
    }
  });
});
