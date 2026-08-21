import { describe, expect, it, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TreeShakingDetectorImpl, LARGE_CHUNK_THRESHOLD } from '../adapters/tree-shaking-detector';

const detector = new TreeShakingDetectorImpl();

/** 创建临时目录并登记清理 */
const dirs: string[] = [];
function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function writeFile(dir: string, name: string, content: string): void {
  const filePath = path.join(dir, name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

afterEach(() => {
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
});

describe('tree-shaking-detector', () => {
  it('package.json 缺少 sideEffects 且为 npm 包 → side-effects-missing（low）', () => {
    const dir = tmpDir('zh-perf-side-missing-');
    writeFile(dir, 'package.json', JSON.stringify({
      name: 'demo',
      version: '1.0.0',
      main: 'dist/index.js',
    }));

    const issues = detector.detect(dir);

    expect(issues).toHaveLength(1);
    expect(issues[0].ruleId).toBe('tree-shaking.side-effects-missing');
    expect(issues[0].severity).toBe('low');
    expect(issues[0].category).toBe('tree-shaking');
    expect(issues[0].file).toBe('package.json');
    expect(issues[0].message).toContain('sideEffects');
    expect(issues[0].message).toMatch(/[\u4e00-\u9fa5]/);
    expect(issues[0].autoFixable).toBe(false);
  });

  it('sideEffects 显式为 true → side-effects-true（high）', () => {
    const dir = tmpDir('zh-perf-side-true-');
    writeFile(dir, 'package.json', JSON.stringify({
      name: 'demo',
      version: '1.0.0',
      sideEffects: true,
    }));

    const issues = detector.detect(dir);

    expect(issues).toHaveLength(1);
    expect(issues[0].ruleId).toBe('tree-shaking.side-effects-true');
    expect(issues[0].severity).toBe('high');
    expect(issues[0].category).toBe('tree-shaking');
  });

  it('src/index.ts 全量引入 lodash → whole-library-import（medium）', () => {
    const dir = tmpDir('zh-perf-lodash-');
    writeFile(dir, 'package.json', JSON.stringify({ name: 'demo', version: '1.0.0' }));
    writeFile(dir, 'src/index.ts', "import _ from 'lodash';\nexport default _;\n");

    const issues = detector.detect(dir);

    const hit = issues.find((i) => i.ruleId === 'tree-shaking.whole-library-import');
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe('medium');
    expect(hit?.category).toBe('tree-shaking');
    expect(hit?.file).toBe('src/index.ts');
    expect(hit?.message).toContain('lodash');
    expect(hit?.message).toMatch(/[\u4e00-\u9fa5]/);
  });

  it('子路径引入 lodash/debounce → 不产生 whole-library 问题', () => {
    const dir = tmpDir('zh-perf-lodash-sub-');
    writeFile(dir, 'package.json', JSON.stringify({ name: 'demo', version: '1.0.0' }));
    writeFile(dir, 'src/index.ts', "import { debounce } from 'lodash/debounce';\n");

    const issues = detector.detect(dir);

    expect(issues.some((i) => i.ruleId === 'tree-shaking.whole-library-import')).toBe(false);
  });

  it('dist 内单个 2MB chunk → large-chunk（high）', () => {
    const dir = tmpDir('zh-perf-large-chunk-');
    writeFile(dir, 'package.json', JSON.stringify({ name: 'demo', version: '1.0.0' }));
    const chunkPath = path.join(dir, 'dist', 'assets', 'vendor.js');
    fs.mkdirSync(path.dirname(chunkPath), { recursive: true });
    fs.writeFileSync(chunkPath, Buffer.alloc(2 * 1024 * 1024));

    const issues = detector.detect(dir);

    const hit = issues.find((i) => i.ruleId === 'chunk-splitting.large-chunk');
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe('high');
    expect(hit?.category).toBe('chunk-splitting');
    expect(hit?.file).toBe('dist/assets/vendor.js');
    expect(hit?.message).toContain('2.0 MB');
    expect(hit?.suggestion).toBeTruthy();
  });

  it('单一小 chunk + 6 个依赖 → no-code-split（medium）', () => {
    const dir = tmpDir('zh-perf-no-split-');
    const deps: Record<string, string> = {};
    for (let i = 1; i <= 6; i++) deps[`dep-${i}`] = '^1.0.0';
    writeFile(dir, 'package.json', JSON.stringify({ name: 'demo', version: '1.0.0', dependencies: deps }));
    writeFile(dir, 'dist/app.js', 'console.log(1);');

    const issues = detector.detect(dir);

    const hit = issues.find((i) => i.ruleId === 'chunk-splitting.no-code-split');
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe('medium');
    expect(hit?.category).toBe('chunk-splitting');
    expect(hit?.message).toContain('代码分割');
  });

  it('无 package.json 且无产物 → 无任何问题', () => {
    const dir = tmpDir('zh-perf-empty-');

    const issues = detector.detect(dir);

    expect(issues).toHaveLength(0);
  });

  it('问题对象形状完整：字段齐全、中文消息、类别正确、排序按严重度', () => {
    const dir = tmpDir('zh-perf-shape-');
    writeFile(dir, 'package.json', JSON.stringify({ name: 'demo', version: '1.0.0' }));
    writeFile(dir, 'src/index.ts', "import _ from 'lodash';\n");
    writeFile(dir, 'dist/vendor.js', Buffer.from('x'.repeat(LARGE_CHUNK_THRESHOLD + 1024)));

    const issues = detector.detect(dir);

    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(typeof issue.id).toBe('string');
      expect(typeof issue.ruleId).toBe('string');
      expect(['tree-shaking', 'chunk-splitting']).toContain(issue.category);
      expect(typeof issue.file).toBe('string');
      expect(typeof issue.message).toBe('string');
      expect(issue.message).toMatch(/[\u4e00-\u9fa5]/);
      expect(typeof issue.autoFixable).toBe('boolean');
    }
    const high = issues.findIndex((i) => i.severity === 'high');
    const medium = issues.findIndex((i) => i.severity === 'medium');
    expect(high).toBeLessThan(medium);
  });
});
