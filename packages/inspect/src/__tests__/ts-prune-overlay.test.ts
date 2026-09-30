import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { buildMonorepoPruneOverlay, type MonorepoPruneOverlay } from '../adapters/ts-prune-adapter';

/**
 * buildMonorepoPruneOverlay 聚合语义测试。
 *
 * 覆盖：monorepo 判定、include/exclude/paths 逐包聚合、.zhshield/ 相对前缀
 * （include/exclude 相对 config 目录需 '../'；paths 相对 baseUrl 用 './'）、
 * @zh/<pkg> 入口映射、坏 tsconfig 与缺失 include 的宽容处理、非 monorepo 返回 null。
 */

describe('buildMonorepoPruneOverlay', () => {
  let projectPath: string;

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(tmpdir(), 'ts-prune-overlay-'));
  });

  afterEach(() => {
    rmSync(projectPath, { recursive: true, force: true });
  });

  const writeConfig = (pkg: string, content: unknown): void => {
    const dir = path.join(projectPath, 'packages', pkg);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify(content, null, 2), 'utf8');
  };

  const writeIndex = (pkg: string): void => {
    const dir = path.join(projectPath, 'packages', pkg, 'src');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'index.ts'), 'export const x = 1;\n', 'utf8');
  };

  it('非 monorepo（无 packages/ 目录）→ null', () => {
    expect(buildMonorepoPruneOverlay(projectPath)).toBeNull();
  });

  it('非 monorepo（packages/ 目录存在但为空）→ null', () => {
    mkdirSync(path.join(projectPath, 'packages'), { recursive: true });
    expect(buildMonorepoPruneOverlay(projectPath)).toBeNull();
  });

  it('单个 skip 包符合聚合 include/exclude/paths，且 .zhshield/ 前缀语义正确', () => {
    writeConfig('db', {
      include: ['src'],
      exclude: ['src/__tests__'],
      compilerOptions: { paths: { '@/*': ['./src/*'] } },
    });
    writeIndex('db');

    const overlay = buildMonorepoPruneOverlay(projectPath);
    expect(overlay).not.toBeNull();

    // include/exclude 相对 overlay 所在目录（.zhshield/）→ '../' 前缀指回项目根
    // 包根 *.ts 一并纳入：vitest.config.ts 等包根文件是共享源码的真实消费者
    expect(overlay!.include).toEqual(['../packages/db/*.ts', '../packages/db/src/**/*']);
    // 测试目录是合法消费者，不再排除（否则仅有测试引用的导出会被误判为死代码）
    expect(overlay!.exclude).not.toContain('../packages/db/src/__tests__');
    // 固定排除项同样加 '../'
    expect(overlay!.exclude).toContain('../node_modules');
    expect(overlay!.exclude).toContain('../**/dist');
    // include 通配带入的编译产物需排除，否则互相"引用"掩盖真实死代码
    expect(overlay!.exclude).toEqual(
      expect.arrayContaining([
        '../packages/db/**/*.d.ts',
        '../packages/db/**/*.js',
        '../packages/db/**/*.js.map',
      ]),
    );

    // baseUrl 相对 config 目录 → '..'（= 项目根）
    expect(overlay!.compilerOptions.baseUrl).toBe('..');
    // paths 相对 baseUrl（= 项目根），带 './' 前缀
    expect(overlay!.compilerOptions.paths).toEqual({
      '@/*': ['./packages/db/src/*'],
      '@zh/db': ['./packages/db/src/index.ts'],
    });
  });

  it('多包聚合：include 逐包展开、exclude 并集、@zh/<pkg> 各自映射', () => {
    writeConfig('db', { include: ['src'], exclude: ['src/__tests__'] });
    writeIndex('db');
    writeConfig('desktop', { include: ['src', 'electron'], exclude: ['src/__tests__'] });
    // desktop 无 src/index.ts：@zh/desktop 仍无条件映射，缺失映射会放大成误报级联

    const overlay = buildMonorepoPruneOverlay(projectPath) as MonorepoPruneOverlay;
    expect(overlay.include).toEqual([
      '../packages/db/*.ts',
      '../packages/db/src/**/*',
      '../packages/desktop/*.ts',
      '../packages/desktop/electron/**/*',
      '../packages/desktop/src/**/*',
    ]);
    // 测试目录不再是排除项：测试是合法消费者
    expect(overlay.exclude).not.toContain('../packages/db/src/__tests__');
    expect(overlay.exclude).not.toContain('../packages/desktop/src/__tests__');
    expect(overlay.exclude).toEqual(
      expect.arrayContaining(['../packages/db/**/*.d.ts', '../packages/desktop/**/*.js']),
    );
    expect(overlay.compilerOptions.paths['@zh/db']).toEqual(['./packages/db/src/index.ts']);
    expect(overlay.compilerOptions.paths['@zh/desktop']).toEqual([
      './packages/desktop/src/index.ts',
    ]);
  });

  it('无 include 字段的包默认 src；坏 tsconfig 的包被跳过但不阻断其余聚合', () => {
    writeConfig('noInclude', { exclude: ['src/__tests__'] });
    writeIndex('noInclude');
    writeConfig('broken', { include: ['src'] }); // 由坏 JSON 覆盖
    writeFileSync(
      path.join(projectPath, 'packages', 'broken', 'tsconfig.json'),
      '{ invalid json',
      'utf8',
    );

    const overlay = buildMonorepoPruneOverlay(projectPath) as MonorepoPruneOverlay;
    // broken 被跳过，noInclude 正常聚合（include 默认 src）
    expect(overlay.include).toEqual(['../packages/noInclude/*.ts', '../packages/noInclude/src/**/*']);
    expect(overlay.compilerOptions.paths['@zh/noInclude']).toEqual([
      './packages/noInclude/src/index.ts',
    ]);
  });

  it('若所有包的 tsconfig 都坏 → null（不产出空 overlay 造成 0 文件扫描）', () => {
    writeConfig('broken', { include: ['src'] });
    writeFileSync(
      path.join(projectPath, 'packages', 'broken', 'tsconfig.json'),
      '{ invalid json',
      'utf8',
    );

    expect(buildMonorepoPruneOverlay(projectPath)).toBeNull();
  });
});