import { describe, expect, it, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BuildConfigDetectorImpl } from '../adapters/build-config-detector';

const ID_RE = /^build-config-\d+$/;
const CJK_RE = /[\u4e00-\u9fa5]/;

/** 创建临时目录并登记清理 */
const dirs: string[] = [];
function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function writeFile(dir: string, name: string, content: string): string {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

afterEach(() => {
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
});

const detector = new BuildConfigDetectorImpl();

describe('BuildConfigDetectorImpl vite', () => {
  it('vite.config.ts 显式 minify: false → high 问题，ruleId 为 build-config.vite-minify-disabled', () => {
    const dir = tmpDir('zh-perf-vite-minify-');
    writeFile(
      dir,
      'vite.config.ts',
      [
        "import { defineConfig } from 'vite';",
        'export default defineConfig({',
        '  build: {',
        '    minify: false,',
        '  },',
        '});',
      ].join('\n'),
    );

    const issues = detector.detect(dir);
    expect(issues).toHaveLength(1);
    expect(issues[0].ruleId).toBe('build-config.vite-minify-disabled');
    expect(issues[0].severity).toBe('high');
    expect(issues[0].file).toBe('vite.config.ts');
  });

  it('vite 开启 sourcemap 与过大 chunkSizeWarningLimit → info + medium 问题', () => {
    const dir = tmpDir('zh-perf-vite-sourcemap-');
    writeFile(
      dir,
      'vite.config.ts',
      [
        'export default {',
        '  build: {',
        '    sourcemap: true,',
        '    chunkSizeWarningLimit: 2000,',
        '  },',
        '};',
      ].join('\n'),
    );

    const issues = detector.detect(dir);
    expect(issues.map((i) => i.severity)).toEqual(['medium', 'info']);
    expect(issues.map((i) => i.ruleId)).toContain('build-config.vite-sourcemap-enabled');
    expect(issues.map((i) => i.ruleId)).toContain('build-config.vite-chunk-size-limit-high');
  });

  it('vite 未显式关闭 minify → 不产生 minify 问题', () => {
    const dir = tmpDir('zh-perf-vite-ok-');
    writeFile(dir, 'vite.config.ts', 'export default { build: {} };');

    const issues = detector.detect(dir);
    expect(issues.some((i) => i.ruleId === 'build-config.vite-minify-disabled')).toBe(false);
  });
});

describe('BuildConfigDetectorImpl webpack', () => {
  it('webpack.config.js 无 mode → high 问题 build-config.webpack-mode-missing', () => {
    const dir = tmpDir('zh-perf-wp-nomode-');
    writeFile(dir, 'webpack.config.js', "module.exports = { entry: './src/index.js' };");

    const issues = detector.detect(dir);
    expect(issues).toHaveLength(1);
    expect(issues[0].ruleId).toBe('build-config.webpack-mode-missing');
    expect(issues[0].severity).toBe('high');
  });

  it("webpack mode: 'production' → 无 mode 问题", () => {
    const dir = tmpDir('zh-perf-wp-prod-');
    writeFile(dir, 'webpack.config.js', "module.exports = { mode: 'production' };");

    const issues = detector.detect(dir);
    expect(issues.some((i) => i.ruleId === 'build-config.webpack-mode-missing')).toBe(false);
    expect(issues.some((i) => i.ruleId === 'build-config.webpack-mode-not-production')).toBe(false);
  });

  it('webpack mode 非 production → high 问题', () => {
    const dir = tmpDir('zh-perf-wp-dev-');
    writeFile(dir, 'webpack.config.js', "module.exports = { mode: 'development' };");

    const issues = detector.detect(dir);
    expect(issues[0].ruleId).toBe('build-config.webpack-mode-not-production');
    expect(issues[0].severity).toBe('high');
  });

  it('webpack minimize: false + devtool source-map → high + info 问题', () => {
    const dir = tmpDir('zh-perf-wp-minimize-');
    writeFile(
      dir,
      'webpack.config.js',
      [
        'module.exports = {',
        "  mode: 'production',",
        '  optimization: { minimize: false },',
        "  devtool: 'source-map',",
        '};',
      ].join('\n'),
    );

    const issues = detector.detect(dir);
    expect(issues.map((i) => i.ruleId)).toContain('build-config.webpack-minimize-disabled');
    expect(issues.map((i) => i.ruleId)).toContain('build-config.webpack-devtool-sourcemap');
  });
});

describe('BuildConfigDetectorImpl package.json 构建脚本', () => {
  it('build 脚本含 NODE_ENV=development → high 问题', () => {
    const dir = tmpDir('zh-perf-script-dev-');
    writeFile(
      dir,
      'package.json',
      JSON.stringify({
        scripts: { build: 'NODE_ENV=development vite build' },
      }),
    );

    const issues = detector.detect(dir);
    expect(issues).toHaveLength(1);
    expect(issues[0].ruleId).toBe('build-config.script-node-env-development');
    expect(issues[0].severity).toBe('high');
  });

  it('build 脚本含 --no-minify 与 --sourcemap → high + info 问题', () => {
    const dir = tmpDir('zh-perf-script-flags-');
    writeFile(
      dir,
      'package.json',
      JSON.stringify({
        scripts: { build: 'vite build --no-minify --sourcemap' },
      }),
    );

    const issues = detector.detect(dir);
    expect(issues.map((i) => i.severity)).toEqual(['high', 'info']);
    expect(issues.map((i) => i.ruleId)).toContain('build-config.script-minify-disabled');
    expect(issues.map((i) => i.ruleId)).toContain('build-config.script-sourcemap');
  });
});

describe('BuildConfigDetectorImpl 边界', () => {
  it('无任何构建配置与脚本 → 返回空数组（非错误）', () => {
    const dir = tmpDir('zh-perf-none-');
    writeFile(dir, 'package.json', JSON.stringify({ name: 'app' }));

    expect(() => detector.detect(dir)).not.toThrow();
    expect(detector.detect(dir)).toEqual([]);
  });

  it('目录不存在 → 返回空数组，不抛异常', () => {
    const missing = path.join(os.tmpdir(), 'zh-perf-missing-dir-xxx');
    expect(() => detector.detect(missing)).not.toThrow();
    expect(detector.detect(missing)).toEqual([]);
  });

  it('package.json 损坏 → 仅按配置文件扫描，不抛异常', () => {
    const dir = tmpDir('zh-perf-badpkg-');
    writeFile(dir, 'package.json', '{not json');
    writeFile(dir, 'vite.config.ts', 'export default { build: { minify: false } };');

    expect(() => detector.detect(dir)).not.toThrow();
    const issues = detector.detect(dir);
    expect(issues).toHaveLength(1);
    expect(issues[0].ruleId).toBe('build-config.vite-minify-disabled');
  });

  it('问题结构完整：id/ruleId/category/severity/file/message/suggestion/autoFixable，message 为中文', () => {
    const dir = tmpDir('zh-perf-shape-');
    writeFile(dir, 'vite.config.ts', 'export default { build: { minify: false } };');

    const issues = detector.detect(dir);
    expect(issues).toHaveLength(1);
    const issue = issues[0];
    expect(issue.id).toMatch(ID_RE);
    expect(issue.ruleId).toBe('build-config.vite-minify-disabled');
    expect(issue.category).toBe('build-config');
    expect(issue.severity).toBe('high');
    expect(issue.file).toBe('vite.config.ts');
    expect(typeof issue.message).toBe('string');
    expect(typeof issue.suggestion).toBe('string');
    expect(issue.autoFixable).toBe(false);
    expect(issue.message).toMatch(CJK_RE);
    expect(issue.suggestion).toMatch(CJK_RE);
  });

  it('多个问题按严重度降序排列（high > medium > low > info）', () => {
    const dir = tmpDir('zh-perf-sort-');
    writeFile(
      dir,
      'webpack.config.js',
      [
        'module.exports = {',
        "  mode: 'production',",
        '  optimization: { minimize: false },',
        "  devtool: 'source-map',",
        '};',
      ].join('\n'),
    );

    const issues = detector.detect(dir);
    expect(issues.length).toBeGreaterThanOrEqual(2);
    const order = ['high', 'medium', 'low', 'info'];
    for (let i = 1; i < issues.length; i++) {
      expect(order.indexOf(issues[i - 1].severity)).toBeLessThanOrEqual(
        order.indexOf(issues[i].severity),
      );
    }
  });
});
