import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { resolveInjectedConfigPath, toRealFsPath } from '../adapters/injected-config';

/**
 * SOP 规则声明的工具配置路径解析（2026-09-22 建立）
 *
 * 背景：规则的 `check.toolConfig.config` 常写成内核资产路径
 * （`node_modules/@zh/kernel/dist/assets/semgrep/xxx.yml`）。该路径能否解析，
 * 决定规则是「真跑」还是「静默 skipped」——
 *   桌面端 Electron：node_modules 内有 @zh/kernel ⇒ 正常解析
 *   CLI：packages/cli 未声明 @zh/kernel 依赖，代码被 bundle 进单文件
 *        ⇒ require.resolve 必然 MODULE_NOT_FOUND，且扫描子目录时
 *          `<projectPath>/packages/kernel` 也落空 ⇒ 规则退化为
 *          「Semgrep 配置不存在，跳过该规则」（同一规则两入口行为不一致）
 *
 * 本测试锁死该回退链：即使 kernel 不在 node_modules，也要按目录层级回溯到仓库内的包。
 */
const KERNEL_ASSET = 'node_modules/@zh/kernel/dist/assets/semgrep/path-traversal.yml';

describe('resolveInjectedConfigPath — 内核资产回退链', () => {
  it('projectPath 是仓库内子包（CLI 场景，node_modules 无 @zh/kernel）时仍能解析', () => {
    // packages/inspect/src/__tests__ → 上三级 = packages/ → cli
    const subPackagePath = path.resolve(__dirname, '..', '..', '..', 'cli');
    const resolved = resolveInjectedConfigPath(KERNEL_ASSET, subPackagePath, subPackagePath);

    expect(resolved).not.toBeNull();
    expect(fs.existsSync(resolved!)).toBe(true);
    expect(resolved!).toContain(path.join('kernel', 'dist', 'assets', 'semgrep'));
  });

  it('projectPath 是 monorepo 根时能解析（<root>/packages/kernel 回退）', () => {
    const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
    const resolved = resolveInjectedConfigPath(KERNEL_ASSET, repoRoot, repoRoot);

    expect(resolved).not.toBeNull();
    expect(fs.existsSync(resolved!)).toBe(true);
  });

  it('内核资产路径不存在时返回 null（调用方据此退化为 skipped 而非硬错误）', () => {
    const subPackagePath = path.resolve(__dirname, '..', '..', '..', 'cli');
    const resolved = resolveInjectedConfigPath(
      'node_modules/@zh/kernel/dist/assets/semgrep/__not_exist__.yml',
      subPackagePath,
      subPackagePath,
    );
    expect(resolved).toBeNull();
  });

  it('不含 @zh/kernel/ 前缀且文件不存在时返回 null', () => {
    const resolved = resolveInjectedConfigPath(
      'node_modules/some-other-pkg/config.yml',
      __dirname,
      __dirname,
    );
    expect(resolved).toBeNull();
  });

  it('相对项目根真实存在的配置优先按项目根解析（不被内核回退抢占）', () => {
    // fixture：在包根放一个真实存在的临时配置文件
    const pkgRoot = path.resolve(__dirname, '..', '..');
    const rel = 'eslint.config.mjs';
    const abs = path.join(pkgRoot, rel);
    const existed = fs.existsSync(abs);
    if (!existed) fs.writeFileSync(abs, 'export default [];\n', 'utf-8');

    try {
      const resolved = resolveInjectedConfigPath(rel, pkgRoot, pkgRoot);
      expect(resolved).toBe(abs);
    } finally {
      if (!existed) fs.rmSync(abs, { force: true });
    }
  });
});

/**
 * asar 打包态路径改写（2026-10-26）：
 * 打包版 semgrep/dep-cruiser/eslint 因配置落在 app.asar 归档内、外部子进程不可读
 * 而全部报错（体检退化盲检）。toRealFsPath 必须把命中 unpacked 的路径改指真实文件。
 */
describe('toRealFsPath（asar 打包态改写）', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zh-asar-'));
  const asarDir = path.join(base, 'app.asar');
  const unpackedDir = path.join(base, 'app.asar.unpacked');
  fs.mkdirSync(path.join(asarDir, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(unpackedDir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(asarDir, 'assets', 'a.yml'), 'x: 1\n');
  fs.writeFileSync(path.join(unpackedDir, 'assets', 'a.yml'), 'x: 1\n');

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('app.asar 路径且 unpacked 下存在同名文件 → 改指 unpacked', () => {
    const p = path.join(asarDir, 'assets', 'a.yml');
    expect(toRealFsPath(p)).toBe(path.join(unpackedDir, 'assets', 'a.yml'));
  });

  it('app.asar 路径但 unpacked 下不存在 → 原样返回（交由上层降级）', () => {
    const p = path.join(asarDir, 'assets', 'missing.yml');
    expect(toRealFsPath(p)).toBe(p);
  });

  it('无 app.asar 段 → 原样返回（开发态/CLI 不受影响）', () => {
    const p = path.join(base, 'assets', 'a.yml');
    expect(toRealFsPath(p)).toBe(p);
  });

  it('已是 app.asar.unpacked 路径 → 原样返回（幂等）', () => {
    const p = path.join(unpackedDir, 'assets', 'a.yml');
    expect(toRealFsPath(p)).toBe(p);
  });
});
