/**
 * 包体积检测器测试（bundle-size-detector.test.ts）
 */
import { describe, expect, it, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BundleSizeDetectorImpl, formatBytes } from '../adapters/bundle-size-detector';

/** 创建临时目录并登记清理 */
const dirs: string[] = [];
function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** 写入产物文件（以 Buffer 分配，避免大字符串内存开销） */
function writeArtifact(dir: string, rel: string, size: number): void {
  const filePath = path.join(dir, rel);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.alloc(size));
}

afterEach(() => {
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
});

describe('bundle-size-detector 大文件检测', () => {
  it('600KB 产物文件 → medium 大文件问题，file 为相对路径且 message 含体积文本', () => {
    const dir = tmpDir('zh-perf-medium-');
    writeArtifact(dir, 'dist/assets/app.js', 600 * 1024);

    const issues = new BundleSizeDetectorImpl().detect(dir);

    expect(issues).toHaveLength(1);
    const issue = issues[0];
    expect(issue.id).toMatch(/^bundle-size-\d+$/);
    expect(issue.ruleId).toBe('bundle-size.large-file');
    expect(issue.category).toBe('bundle-size');
    expect(issue.severity).toBe('medium');
    expect(issue.file).toBe('dist/assets/app.js');
    expect(issue.message).toContain('dist/assets/app.js');
    expect(issue.message).toContain('600.0 KB');
    expect(issue.suggestion).toContain('代码分割');
    expect(issue.autoFixable).toBe(false);
  });

  it('2MB 产物文件 → high 严重度', () => {
    const dir = tmpDir('zh-perf-high-');
    writeArtifact(dir, 'dist/vendor.js', 2 * 1024 * 1024);

    const issues = new BundleSizeDetectorImpl().detect(dir);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('high');
    expect(issues[0].file).toBe('dist/vendor.js');
  });

  it('无 dist/build/out 目录 → 无问题（不将缺失产物视为问题）', () => {
    const dir = tmpDir('zh-perf-nodist-');

    const issues = new BundleSizeDetectorImpl().detect(dir);
    expect(issues).toEqual([]);
  });

  it('analyzeArtifacts=false → 即使存在产物也返回空', () => {
    const dir = tmpDir('zh-perf-disabled-');
    writeArtifact(dir, 'dist/app.js', 2 * 1024 * 1024);

    const issues = new BundleSizeDetectorImpl().detect(dir, { analyzeArtifacts: false });
    expect(issues).toEqual([]);
  });

  it('6MB 单文件 → 同时命中大文件 high 问题与产物总量告警', () => {
    const dir = tmpDir('zh-perf-total-');
    writeArtifact(dir, 'dist/main.js', 6 * 1024 * 1024);

    const issues = new BundleSizeDetectorImpl().detect(dir);

    const large = issues.find((i) => i.ruleId === 'bundle-size.large-file');
    const total = issues.find((i) => i.ruleId === 'bundle-size.total-artifacts');
    expect(large?.severity).toBe('high');
    expect(total?.severity).toBe('low');
    expect(total?.message).toContain('6.0 MB');
    // 排序：high 在前
    expect(issues[0].ruleId).toBe('bundle-size.large-file');
  });

  it('scanLimit=1 且存在 3 个文件 → 仅扫描首个文件，不崩溃', () => {
    const dir = tmpDir('zh-perf-limit-');
    writeArtifact(dir, 'dist/a.js', 700 * 1024);
    writeArtifact(dir, 'dist/b.js', 700 * 1024);
    writeArtifact(dir, 'dist/c.js', 700 * 1024);

    const issues = new BundleSizeDetectorImpl().detect(dir, { scanLimit: 1 });
    expect(issues).toHaveLength(1);
  });

  it('跳过 sourcemap / node_modules / .DS_Store', () => {
    const dir = tmpDir('zh-perf-skip-');
    writeArtifact(dir, 'dist/assets/app.js', 600 * 1024);
    writeArtifact(dir, 'dist/assets/app.js.map', 2 * 1024 * 1024);
    writeArtifact(dir, 'dist/node_modules/x.js', 2 * 1024 * 1024);
    writeArtifact(dir, 'dist/.DS_Store', 600 * 1024);

    const issues = new BundleSizeDetectorImpl().detect(dir);
    expect(issues).toHaveLength(1);
    expect(issues[0].file).toBe('dist/assets/app.js');
  });
});

describe('formatBytes 人类可读', () => {
  it('KB 与 MB 保留 1 位小数', () => {
    expect(formatBytes(600 * 1024)).toBe('600.0 KB');
    expect(formatBytes(2 * 1024 * 1024)).toBe('2.0 MB');
    expect(formatBytes(50 * 1024)).toBe('50.0 KB');
  });
});
