// ManifestDetector 单测：清单文件 → 语言 + 框架（依赖读）+ 包管理器（lockfile 名判断）。

import { describe, expect, it } from 'vitest';
import type { Signal } from '../types';
import { ManifestDetector } from '../detectors/manifest-detector';
import { isRecord } from '../fs-utils';
import { makeTempProject, cleanupTempProject } from './helpers';

const detector = new ManifestDetector();

function signalByRuleId(signals: readonly Signal[], ruleId: string): Signal {
  const signal = signals.find((s) => s.ruleId === ruleId);
  if (signal === undefined) throw new Error(`missing signal: ${ruleId}`);
  return signal;
}

function depsOf(signals: readonly Signal[], ruleId: string): string[] {
  const payload = signalByRuleId(signals, ruleId).payload;
  if (!isRecord(payload) || !Array.isArray(payload.deps)) throw new Error(`payload.deps missing for ${ruleId}`);
  return payload.deps.filter((d): d is string => typeof d === 'string');
}

describe('ManifestDetector', () => {
  it('GIVEN 根 package.json（next + typescript + workspaces）与 pnpm-lock.yaml WHEN detect THEN 产出语言/框架/包管理器信号且 kind/weight 正确', async () => {
    const root = makeTempProject({
      'package.json': JSON.stringify({
        name: 'demo',
        private: true,
        workspaces: ['packages/*'],
        dependencies: { next: '^14.0.0', react: '^18.0.0' },
        devDependencies: { typescript: '^5.4.0' },
        engines: { node: '>=20' },
      }),
      'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
      'tsconfig.json': '{}',
    });
    try {
      const signals = await detector.detect(root);

      const pkg = signalByRuleId(signals, 'manifest:package-json');
      expect(pkg.kind).toBe('manifest');
      expect(pkg.weight).toBe(1);
      expect(pkg.file).toBe('package.json');

      expect(signals.map((s) => s.ruleId)).toContain('manifest:typescript-dep');
      expect(signals.map((s) => s.ruleId)).toContain('manifest:workspace');

      const next = signalByRuleId(signals, 'manifest:framework:next-js');
      expect(next.payload).toEqual(expect.objectContaining({ framework: 'Next.js' }));

      const manager = signalByRuleId(signals, 'manifest:package-manager:pnpm');
      expect(manager.file).toBe('pnpm-lock.yaml');

      expect(signals.every((s) => s.kind === 'manifest')).toBe(true);
      expect(signals.every((s) => s.weight === 1)).toBe(true);
    } finally {
      cleanupTempProject(root);
    }
  });

  it('GIVEN pyproject.toml 含 fastapi WHEN detect THEN 产出 python 语言信号与 FastAPI 框架信号', async () => {
    const root = makeTempProject({
      'pyproject.toml': '[project]\nname = "api"\ndependencies = [\n  "fastapi==0.111.0",\n  "uvicorn",\n]\n',
    });
    try {
      const signals = await detector.detect(root);

      expect(depsOf(signals, 'manifest:pyproject')).toEqual(expect.arrayContaining(['fastapi', 'uvicorn']));
      const fastapi = signalByRuleId(signals, 'manifest:framework:fastapi');
      expect(fastapi.payload).toEqual(expect.objectContaining({ language: 'python' }));
      expect(fastapi.file).toBe('pyproject.toml');
    } finally {
      cleanupTempProject(root);
    }
  });

  it('GIVEN requirements.txt 含 flask 与 django WHEN detect THEN 产出语言信号与 Flask 框架信号', async () => {
    const root = makeTempProject({
      'requirements.txt': '# 生产依赖\nflask==3.0.0\ndjango>=5.0\n',
    });
    try {
      const signals = await detector.detect(root);

      expect(depsOf(signals, 'manifest:requirements-txt')).toEqual(expect.arrayContaining(['flask', 'django']));
      expect(signals.map((s) => s.ruleId)).toContain('manifest:framework:flask');
    } finally {
      cleanupTempProject(root);
    }
  });

  it('GIVEN go.mod 含 gin WHEN detect THEN 产出 go 语言信号与 Gin 框架信号', async () => {
    const root = makeTempProject({
      'go.mod': 'module example.com/demo\n\ngo 1.22\n\nrequire github.com/gin-gonic/gin v1.9.1\n',
    });
    try {
      const signals = await detector.detect(root);

      expect(depsOf(signals, 'manifest:go-mod')).toContain('github.com/gin-gonic/gin');
      expect(signalByRuleId(signals, 'manifest:framework:gin').file).toBe('go.mod');
    } finally {
      cleanupTempProject(root);
    }
  });

  it('GIVEN 空目录 WHEN detect THEN 不产出任何信号', async () => {
    const root = makeTempProject({});
    try {
      const signals = await detector.detect(root);
      expect(signals).toEqual([]);
    } finally {
      cleanupTempProject(root);
    }
  });
});
