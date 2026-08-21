// LockfileDetector 单测：各生态 lockfile 直接依赖清单解析（M0 只存清单）。

import { describe, expect, it } from 'vitest';
import type { Signal } from '../types';
import { LockfileDetector } from '../detectors/lockfile-detector';
import { isRecord } from '../fs-utils';
import { makeTempProject, cleanupTempProject } from './helpers';

const detector = new LockfileDetector();

function directOf(signals: readonly Signal[], ruleId: string): Array<{ name: string; version: string }> {
  const signal = signals.find((s) => s.ruleId === ruleId);
  if (signal === undefined) throw new Error(`missing signal: ${ruleId}`);
  const payload = signal.payload;
  if (!isRecord(payload) || !Array.isArray(payload.direct)) throw new Error(`payload.direct missing for ${ruleId}`);
  return payload.direct.filter(
    (d): d is { name: string; version: string } =>
      isRecord(d) && typeof d.name === 'string' && typeof d.version === 'string',
  );
}

describe('LockfileDetector', () => {
  it('GIVEN package-lock.json（根 packages[""] 依赖）WHEN detect THEN 产出 lockfile:package-lock 清单', async () => {
    const root = makeTempProject({
      'package-lock.json': JSON.stringify({
        name: 'demo',
        version: '1.0.0',
        lockfileVersion: 3,
        packages: {
          '': {
            dependencies: { express: '^4.19.0' },
            devDependencies: { typescript: '^5.4.0' },
          },
        },
      }),
    });
    try {
      const signals = await detector.detect(root);

      const signal = signals[0];
      expect(signal?.ruleId).toBe('lockfile:package-lock');
      expect(signal?.kind).toBe('lockfile');
      expect(signal?.weight).toBe(0.3);
      expect(signal?.file).toBe('package-lock.json');
      expect(directOf(signals, 'lockfile:package-lock')).toEqual(
        expect.arrayContaining([
          { name: 'express', version: '^4.19.0' },
          { name: 'typescript', version: '^5.4.0' },
        ]),
      );
    } finally {
      cleanupTempProject(root);
    }
  });

  it('GIVEN pnpm-lock.yaml v9 importers 多项目 WHEN detect THEN 产出 lockfile:pnpm 直接依赖清单', async () => {
    const root = makeTempProject({
      'pnpm-lock.yaml': [
        "lockfileVersion: '9.0'",
        '',
        'importers:',
        '',
        '  .:',
        '    dependencies:',
        '      next:',
        '        specifier: ^14.0.0',
        '        version: 14.2.3',
        '',
        '  packages/core:',
        '    dependencies:',
        '      react:',
        '        specifier: ^18.0.0',
        '        version: 18.2.0',
        '',
      ].join('\n'),
    });
    try {
      const signals = await detector.detect(root);

      expect(directOf(signals, 'lockfile:pnpm')).toEqual(
        expect.arrayContaining([
          { name: 'next', version: '14.2.3' },
          { name: 'react', version: '18.2.0' },
        ]),
      );
    } finally {
      cleanupTempProject(root);
    }
  });

  it('GIVEN go.sum WHEN detect THEN 产出 lockfile:go-sum 依赖名清单', async () => {
    const root = makeTempProject({
      'go.sum': [
        'github.com/gin-gonic/gin v1.9.1 h1:xxxxxxxx',
        'github.com/gin-gonic/gin/go.mod v1.9.1 h1:xxxxxxxx',
        'github.com/stretchr/testify v1.8.4 h1:xxxxxxxx',
        '',
      ].join('\n'),
    });
    try {
      const signals = await detector.detect(root);

      expect(directOf(signals, 'lockfile:go-sum')).toEqual(
        expect.arrayContaining([
          { name: 'github.com/gin-gonic/gin', version: 'v1.9.1' },
          { name: 'github.com/stretchr/testify', version: 'v1.8.4' },
        ]),
      );
    } finally {
      cleanupTempProject(root);
    }
  });

  it('GIVEN Cargo.lock WHEN detect THEN 产出 lockfile:cargo 依赖清单', async () => {
    const root = makeTempProject({
      'Cargo.lock': [
        'version = 3',
        '',
        '[[package]]',
        'name = "axum"',
        'version = "0.7.4"',
        'dependencies = [',
        ' "tokio",',
        ']',
        '',
        '[[package]]',
        'name = "tokio"',
        'version = "1.36.0"',
        '',
      ].join('\n'),
    });
    try {
      const signals = await detector.detect(root);

      expect(directOf(signals, 'lockfile:cargo')).toEqual(
        expect.arrayContaining([
          { name: 'axum', version: '0.7.4' },
          { name: 'tokio', version: '1.36.0' },
        ]),
      );
    } finally {
      cleanupTempProject(root);
    }
  });

  it('GIVEN pom.xml 的 <dependency> 块 WHEN detect THEN 产出 lockfile:pom groupId:artifactId 清单', async () => {
    const root = makeTempProject({
      'pom.xml': [
        '<project>',
        '  <dependencies>',
        '    <dependency>',
        '      <groupId>org.springframework.boot</groupId>',
        '      <artifactId>spring-boot-starter-web</artifactId>',
        '      <version>3.2.4</version>',
        '    </dependency>',
        '  </dependencies>',
        '</project>',
        '',
      ].join('\n'),
    });
    try {
      const signals = await detector.detect(root);

      expect(directOf(signals, 'lockfile:pom')).toEqual(
        expect.arrayContaining([
          { name: 'org.springframework.boot:spring-boot-starter-web', version: '3.2.4' },
        ]),
      );
    } finally {
      cleanupTempProject(root);
    }
  });

  it('GIVEN 子目录内 lockfile WHEN detect THEN 只扫描根目录不递归', async () => {
    const root = makeTempProject({
      'pnpm-lock.yaml': [
        "lockfileVersion: '9.0'",
        '',
        'importers:',
        '',
        '  .:',
        '    dependencies:',
        '      react:',
        '        specifier: ^18.0.0',
        '        version: 18.2.0',
        '',
      ].join('\n'),
      'testdata/yarn.lock': [
        '# yarn.lock 应被忽略（子目录）',
        'lodash@^4.0.0:',
        '  version "4.17.21"',
        '',
      ].join('\n'),
    });
    try {
      const signals = await detector.detect(root);
      expect(signals).toHaveLength(1);
      expect(signals[0]?.ruleId).toBe('lockfile:pnpm');
    } finally {
      cleanupTempProject(root);
    }
  });

  it('GIVEN 噪声目录内 lockfile 与空目录 WHEN detect THEN 噪声被跳过且不产出信号', async () => {
    const root = makeTempProject({
      'node_modules/pkg/package-lock.json': JSON.stringify({
        packages: { '': { dependencies: { lodash: '^4.0.0' } } },
      }),
    });
    try {
      const signals = await detector.detect(root);
      expect(signals).toEqual([]);
    } finally {
      cleanupTempProject(root);
    }
  });
});
