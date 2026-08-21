// Profiler 单测：语言判定 / 框架判定 / 形态判定 / 置信度 / 信号追溯

import { describe, expect, it } from 'vitest';
import { Profiler } from '../profiler';
import { ManifestDetector } from '../detectors/manifest-detector';
import { ConfigDetector } from '../detectors/config-detector';
import { FormDetector } from '../detectors/form-detector';
import { makeTempProject, cleanupTempProject } from './helpers';
import type { Signal } from '../types';

// ─── 测试用 Detector ───

class MockDetector {
  readonly id: string;
  readonly signalKinds: readonly string[];
  readonly weight: number;
  private readonly signals: readonly Signal[];

  constructor(id: string, signals: readonly Signal[]) {
    this.id = id;
    this.signalKinds = ['manifest'];
    this.weight = 1.0;
    this.signals = signals;
  }

  async detect(): Promise<Signal[]> {
    return [...this.signals];
  }
}

// ─── 测试数据 ───

// ─── 测试用例 ───

describe('Profiler', () => {
  describe('语言判定', () => {
    it('GIVEN package.json 依赖 WHEN profile THEN 判定为 javascript', async () => {
      const root = makeTempProject({
        'package.json': JSON.stringify({
          name: 'test',
          dependencies: { react: '^18.0.0' },
        }),
      });

      try {
        const profiler = new Profiler([new ManifestDetector()]);
        const profile = await profiler.profile(root);

        expect(profile.targets[0].language.value).toBe('javascript');
        expect(profile.targets[0].language.confidence).toBeGreaterThan(0.5);
        expect(profile.targets[0].language.signals.length).toBeGreaterThan(0);
      } finally {
        cleanupTempProject(root);
      }
    });

    it('GIVEN package.json + tsconfig.json WHEN profile THEN 判定为 typescript', async () => {
      const root = makeTempProject({
        'package.json': JSON.stringify({
          name: 'test',
          dependencies: { react: '^18.0.0' },
        }),
        'tsconfig.json': JSON.stringify({ compilerOptions: {} }),
      });

      try {
        const profiler = new Profiler([new ManifestDetector(), new ConfigDetector()]);
        const profile = await profiler.profile(root);

        expect(profile.targets[0].language.value).toBe('typescript');
        expect(profile.targets[0].language.confidence).toBeGreaterThan(0.7);
      } finally {
        cleanupTempProject(root);
      }
    });

    it('GIVEN pyproject.toml WHEN profile THEN 判定为 python', async () => {
      const root = makeTempProject({
        'pyproject.toml': '[project]\ndependencies = ["fastapi>=0.100.0"]\n',
      });

      try {
        const profiler = new Profiler([new ManifestDetector()]);
        const profile = await profiler.profile(root);

        expect(profile.targets[0].language.value).toBe('python');
        expect(profile.targets[0].language.confidence).toBeGreaterThan(0.5);
      } finally {
        cleanupTempProject(root);
      }
    });

    it('GIVEN go.mod WHEN profile THEN 判定为 go', async () => {
      const root = makeTempProject({
        'go.mod': 'module example.com/mymod\n\ngo 1.21\n',
      });

      try {
        const profiler = new Profiler([new ManifestDetector()]);
        const profile = await profiler.profile(root);

        expect(profile.targets[0].language.value).toBe('go');
        expect(profile.targets[0].language.confidence).toBeGreaterThan(0.5);
      } finally {
        cleanupTempProject(root);
      }
    });

    it('GIVEN 空目录 WHEN profile THEN 判定为 unknown', async () => {
      const root = makeTempProject({});

      try {
        const profiler = new Profiler([new ManifestDetector()]);
        const profile = await profiler.profile(root);

        expect(profile.targets[0].language.value).toBe('unknown');
        expect(profile.targets[0].language.confidence).toBe(0);
      } finally {
        cleanupTempProject(root);
      }
    });
  });

  describe('框架判定', () => {
    it('GIVEN Next.js 依赖 WHEN profile THEN 判定框架为 Next.js', async () => {
      const root = makeTempProject({
        'package.json': JSON.stringify({
          name: 'test',
          dependencies: { next: '^14.0.0', react: '^18.0.0' },
        }),
        'tsconfig.json': JSON.stringify({ compilerOptions: {} }),
      });

      try {
        const profiler = new Profiler([new ManifestDetector(), new ConfigDetector()]);
        const profile = await profiler.profile(root);

        expect(profile.targets[0].frameworks.length).toBeGreaterThan(0);
        expect(profile.targets[0].frameworks[0].value).toBe('Next.js');
      } finally {
        cleanupTempProject(root);
      }
    });

    it('GIVEN NestJS 依赖 WHEN profile THEN 判定框架为 NestJS', async () => {
      const root = makeTempProject({
        'package.json': JSON.stringify({
          name: 'test',
          dependencies: { '@nestjs/core': '^10.0.0' },
        }),
        'nest-cli.json': JSON.stringify({ collection: '@nestjs/schematics' }),
      });

      try {
        const profiler = new Profiler([new ManifestDetector(), new ConfigDetector()]);
        const profile = await profiler.profile(root);

        expect(profile.targets[0].frameworks.length).toBeGreaterThan(0);
        const frameworkNames = profile.targets[0].frameworks.map((f) => f.value);
        expect(frameworkNames).toContain('NestJS');
      } finally {
        cleanupTempProject(root);
      }
    });

    it('GIVEN Django 依赖 WHEN profile THEN 判定框架为 Django', async () => {
      const root = makeTempProject({
        'pyproject.toml': '[project]\ndependencies = ["django>=4.2"]\n',
      });

      try {
        const profiler = new Profiler([new ManifestDetector()]);
        const profile = await profiler.profile(root);

        expect(profile.targets[0].frameworks.length).toBeGreaterThan(0);
        expect(profile.targets[0].frameworks[0].value).toBe('Django');
      } finally {
        cleanupTempProject(root);
      }
    });
  });

  describe('形态判定', () => {
    it('GIVEN electron 依赖 WHEN profile THEN 判定形态为 pc', async () => {
      const root = makeTempProject({
        'package.json': JSON.stringify({
          name: 'test',
          dependencies: { electron: '^30.0.0' },
        }),
      });

      try {
        const profiler = new Profiler([new FormDetector()]);
        const profile = await profiler.profile(root);

        expect(profile.targets[0].productForm).toBeDefined();
        expect(profile.targets[0].productForm?.value).toBe('pc');
      } finally {
        cleanupTempProject(root);
      }
    });

    it('GIVEN Podfile + xcodeproj WHEN profile THEN 判定形态为 ios', async () => {
      const root = makeTempProject({
        'ios/Podfile': "platform :ios, '15.0'\ntarget 'App' do\nend\n",
        'ios/App.xcodeproj/project.pbxproj': '// pbxproj placeholder\n',
      });

      try {
        const profiler = new Profiler([new FormDetector()]);
        const profile = await profiler.profile(root);

        expect(profile.targets[0].productForm).toBeDefined();
        expect(profile.targets[0].productForm?.value).toBe('ios');
      } finally {
        cleanupTempProject(root);
      }
    });

    it('GIVEN project.config.json WHEN profile THEN 判定形态为 miniapp', async () => {
      const root = makeTempProject({
        'miniapp/project.config.json': '{ "appid": "touristappid", "compileType": "miniprogram" }',
      });

      try {
        const profiler = new Profiler([new FormDetector()]);
        const profile = await profiler.profile(root);

        expect(profile.targets[0].productForm).toBeDefined();
        expect(profile.targets[0].productForm?.value).toBe('miniapp');
      } finally {
        cleanupTempProject(root);
      }
    });

    it('GIVEN index.html + vite.config.ts WHEN profile THEN 判定形态为 h5', async () => {
      const root = makeTempProject({
        'index.html': '<!doctype html><html><body></body></html>\n',
        'vite.config.ts': 'export default {}',
      });

      try {
        const profiler = new Profiler([new FormDetector()]);
        const profile = await profiler.profile(root);

        expect(profile.targets[0].productForm).toBeDefined();
        expect(profile.targets[0].productForm?.value).toBe('h5');
      } finally {
        cleanupTempProject(root);
      }
    });

    it('GIVEN 服务端框架 + db 配置 + api 目录 WHEN profile THEN 判定形态为 backend', async () => {
      const root = makeTempProject({
        'pyproject.toml': '[project]\ndependencies = ["fastapi==0.111.0"]\n',
        '.env': 'DATABASE_URL=postgres://localhost/app\n',
        'api/routes.py': 'from fastapi import APIRouter\n',
      });

      try {
        const profiler = new Profiler([new FormDetector()]);
        const profile = await profiler.profile(root);

        expect(profile.targets[0].productForm).toBeDefined();
        expect(profile.targets[0].productForm?.value).toBe('backend');
      } finally {
        cleanupTempProject(root);
      }
    });
  });

  describe('置信度', () => {
    it('GIVEN 多个语言信号 WHEN profile THEN 置信度按权重计算', async () => {
      const root = makeTempProject({
        'package.json': JSON.stringify({
          name: 'test',
          dependencies: { typescript: '^5.0.0' },
        }),
        'tsconfig.json': JSON.stringify({ compilerOptions: {} }),
      });

      try {
        const profiler = new Profiler([new ManifestDetector(), new ConfigDetector()]);
        const profile = await profiler.profile(root);

        // TypeScript 应该有高置信度（manifest + config 双重确认）
        expect(profile.targets[0].language.confidence).toBeGreaterThan(0.8);
      } finally {
        cleanupTempProject(root);
      }
    });

    it('GIVEN 低置信度信号 WHEN profile THEN confidence < 0.6 时输出 unknown', async () => {
      // 只有 ext-stat 信号，置信度较低
      const mockDetector = new MockDetector('mock', [
        {
          ruleId: 'ext-stat:py',
          kind: 'ext-stat',
          file: 'src/main.py',
          weight: 0.6,
          payload: { count: 1, total: 10 },
        },
      ]);

      const profiler = new Profiler([mockDetector]);
      const root = makeTempProject({});
      try {
        const profile = await profiler.profile(root);

        // 低置信度应该输出 unknown
        expect(profile.targets[0].language.confidence).toBeLessThan(0.6);
      } finally {
        cleanupTempProject(root);
      }
    });
  });

  describe('信号追溯', () => {
    it('GIVEN 检测信号 WHEN profile THEN signals 字段包含所有原始信号', async () => {
      const root = makeTempProject({
        'package.json': JSON.stringify({
          name: 'test',
          dependencies: { react: '^18.0.0' },
        }),
        'tsconfig.json': JSON.stringify({ compilerOptions: {} }),
      });

      try {
        const profiler = new Profiler([new ManifestDetector(), new ConfigDetector()]);
        const profile = await profiler.profile(root);

        // signals 应该包含所有检测到的信号
        expect(profile.signals.length).toBeGreaterThan(0);

        // 每个信号都应该有 ruleId, kind, file, weight, payload
        for (const signal of profile.signals) {
          expect(signal.ruleId).toBeDefined();
          expect(signal.kind).toBeDefined();
          expect(signal.file).toBeDefined();
          expect(signal.weight).toBeGreaterThan(0);
          expect(signal.payload).toBeDefined();
        }
      } finally {
        cleanupTempProject(root);
      }
    });
  });

  describe('架构形态', () => {
    it('GIVEN workspaces 字段 WHEN profile THEN 判定为 modular-monolith', async () => {
      const root = makeTempProject({
        'package.json': JSON.stringify({
          name: 'monorepo',
          workspaces: ['packages/*'],
        }),
      });

      try {
        const profiler = new Profiler([new ManifestDetector()]);
        const profile = await profiler.profile(root);

        expect(profile.architecture.value).toBe('modular-monolith');
        expect(profile.architecture.confidence).toBeGreaterThan(0.5);
      } finally {
        cleanupTempProject(root);
      }
    });

    it('GIVEN 无 workspaces 字段 WHEN profile THEN 判定为 monolith', async () => {
      const root = makeTempProject({
        'package.json': JSON.stringify({
          name: 'single-app',
          dependencies: { react: '^18.0.0' },
        }),
      });

      try {
        const profiler = new Profiler([new ManifestDetector()]);
        const profile = await profiler.profile(root);

        expect(profile.architecture.value).toBe('monolith');
        expect(profile.architecture.confidence).toBeGreaterThan(0.5);
      } finally {
        cleanupTempProject(root);
      }
    });
  });

  describe('依赖摘要', () => {
    it('GIVEN package.json 依赖 WHEN profile THEN dependencies 包含直接依赖', async () => {
      const root = makeTempProject({
        'package.json': JSON.stringify({
          name: 'test',
          dependencies: {
            react: '^18.0.0',
            lodash: '^4.17.0',
          },
        }),
      });

      try {
        const profiler = new Profiler([new ManifestDetector()]);
        const profile = await profiler.profile(root);

        expect(profile.dependencies.direct.length).toBeGreaterThan(0);
        const depNames = profile.dependencies.direct.map((d) => d.name);
        expect(depNames).toContain('react');
        expect(depNames).toContain('lodash');
      } finally {
        cleanupTempProject(root);
      }
    });
  });

  describe('人工修正合并', () => {
    it('GIVEN overrides WHEN profile THEN 合并修正记录', async () => {
      const root = makeTempProject({
        'package.json': JSON.stringify({
          name: 'test',
          dependencies: { react: '^18.0.0' },
        }),
      });

      try {
        const profiler = new Profiler([new ManifestDetector()]);
        const overrides = {
          architecture: 'microservices' as const,
          targets: {
            default: {
              language: 'python' as const,
              productForm: 'backend' as const,
            },
          },
        };

        const profile = await profiler.profile(root, overrides);

        // overrides 应该被合并
        expect(profile.overrides.architecture).toBe('microservices');
        expect(profile.overrides.targets?.default.language).toBe('python');
      } finally {
        cleanupTempProject(root);
      }
    });
  });
});
