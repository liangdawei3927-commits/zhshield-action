import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { SopRegistry } from '../sop/_meta/sop-registry';
import { SopLoader } from '../sop/_meta/sop-loader';
import { makeRule } from './helpers/rule-factory';

describe('SopRegistry — 规则库能力声明（serves）查询', () => {
  // ─── getAllServes ──────────────────────────────────────
  describe('getAllServes', () => {
    it('空注册表应返回空对象（无语言/形态/架构数组）', () => {
      // Given: 空注册表
      const reg = new SopRegistry();

      // When: 查询全部能力声明
      const serves = reg.getAllServes();

      // Then: 返回空对象
      expect(serves).toEqual({});
    });

    it('应合并所有已注册规则的 serves 并对数组去重', () => {
      // Given: 注册两条 serves 部分重叠的规则
      const reg = new SopRegistry();
      reg.register(
        makeRule({
          id: 'r-1',
          serves: {
            languages: ['typescript', 'python'],
            productForms: ['website'],
            architectures: ['monolith'],
          },
        }),
      );
      reg.register(
        makeRule({
          id: 'r-2',
          serves: { languages: ['typescript', 'go'], productForms: ['website', 'admin'] },
        }),
      );

      // When: 查询全部能力声明
      const serves = reg.getAllServes();

      // Then: 语言/形态去重合并，架构原样保留
      expect(serves).toEqual({
        languages: ['typescript', 'python', 'go'],
        productForms: ['website', 'admin'],
        architectures: ['monolith'],
      });
    });

    it('未声明 serves 的规则应被忽略', () => {
      // Given: 一条未声明 serves，一条声明了 serves
      const reg = new SopRegistry();
      reg.register(makeRule({ id: 'r-1' }));
      reg.register(makeRule({ id: 'r-2', serves: { languages: ['python'] } }));

      // When: 查询全部能力声明
      const serves = reg.getAllServes();

      // Then: 只包含声明了 serves 的规则
      expect(serves).toEqual({ languages: ['python'] });
    });
  });

  // ─── getServes（按域）──────────────────────────────────
  describe('getServes', () => {
    it('未声明 serves 的域应返回空对象', () => {
      // Given: 只有 guard 域规则声明了 serves
      const reg = new SopRegistry();
      reg.register(
        makeRule({ id: 'r-1', domain: 'guard', serves: { languages: ['typescript'] } }),
      );

      // When: 查询 sentinel 域
      const serves = reg.getServes('sentinel');

      // Then: 返回空对象
      expect(serves).toEqual({});
    });

    it('应只聚合指定域内规则的 serves', () => {
      // Given: guard 域两条规则 + inspect 域一条规则，各带 serves
      const reg = new SopRegistry();
      reg.register(
        makeRule({
          id: 'r-1',
          domain: 'guard',
          serves: { languages: ['typescript'], architectures: ['monolith'] },
        }),
      );
      reg.register(
        makeRule({
          id: 'r-2',
          domain: 'guard',
          serves: { languages: ['python'], productForms: ['admin'] },
        }),
      );
      reg.register(
        makeRule({
          id: 'r-3',
          domain: 'inspect',
          serves: { languages: ['go'], architectures: ['microservices'] },
        }),
      );

      // When: 分别查询 guard / inspect 域
      const guardServes = reg.getServes('guard');
      const inspectServes = reg.getServes('inspect');

      // Then: 各域只包含自己域内规则的合并结果
      expect(guardServes).toEqual({
        languages: ['typescript', 'python'],
        productForms: ['admin'],
        architectures: ['monolith'],
      });
      expect(inspectServes).toEqual({
        languages: ['go'],
        architectures: ['microservices'],
      });
    });

    it('域内规则全部未声明 serves 时应返回空对象', () => {
      // Given: guard 域两条规则均未声明 serves
      const reg = new SopRegistry();
      reg.register(makeRule({ id: 'r-1', domain: 'guard' }));
      reg.register(makeRule({ id: 'r-2', domain: 'guard', tags: ['x'] }));

      // When: 查询 guard 域
      const serves = reg.getServes('guard');

      // Then: 返回空对象
      expect(serves).toEqual({});
    });
  });

  // ─── loadAll 批量注册路径 ──────────────────────────────
  it('loadAll 批量加载后应基于内存规则聚合 serves', () => {
    // Given: 通过 loadAll 批量注册两条 serves 部分重叠的规则
    const reg = new SopRegistry();
    reg.loadAll([
      makeRule({ id: 'r-1', serves: { languages: ['typescript'] } }),
      makeRule({ id: 'r-2', serves: { languages: ['typescript', 'python'] } }),
    ]);

    // When: 查询全部能力声明
    const serves = reg.getAllServes();

    // Then: 去重合并
    expect(serves).toEqual({ languages: ['typescript', 'python'] });
  });

  // ─── SopLoader：YAML 顶层 serves 消化 ──────────────────
  describe('SopLoader — 从 YAML 解析 serves', () => {
    it('loadFromDirectory 应把 YAML 顶层 serves 消化进注册规则', async () => {
      // Given: 临时规则目录下有一条带 serves 声明的 YAML 规则
      const tempDir = mkdtempSync(path.join(tmpdir(), 'sop-serves-test-'));
      try {
        const actionDir = path.join(tempDir, 'inspect', 'scan');
        mkdirSync(actionDir, { recursive: true });
        writeFileSync(
          path.join(actionDir, 'ts-strict.yml'),
          [
            'name: TS Strict',
            'description: strict mode check',
            'status: active',
            'source: official',
            'tags: [typescript]',
            'serves:',
            '  languages: [typescript]',
            '  productForms: [website, admin]',
            '  architectures: [monolith]',
          ].join('\n'),
          'utf-8',
        );
        const reg = new SopRegistry();
        const loader = new SopLoader(reg, { rulesDir: tempDir });

        // When: 从文件系统加载规则
        const loaded = await loader.loadFromFileSystem();

        // Then: 规则已加载且 serves 被聚合
        expect(loaded).toBe(1);
        expect(reg.getAllServes()).toEqual({
          languages: ['typescript'],
          productForms: ['website', 'admin'],
          architectures: ['monolith'],
        });
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
});
