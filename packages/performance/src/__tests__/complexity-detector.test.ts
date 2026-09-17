import { describe, expect, it, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ComplexityDetectorImpl } from '../adapters/complexity-detector';

const CJK_RE = /[\u4e00-\u9fff]/;
const detector = new ComplexityDetectorImpl();

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

describe('complexity-detector', () => {
  it('三层嵌套 for 循环 → nested-loop (medium)', () => {
    const dir = tmpDir('zh-perf-nested-loop-');
    writeFile(
      dir,
      'src/services/heavy.ts',
      [
        'export function heavyAggregate(input: number[]): number {',
        '  let acc = 0;',
        '  for (let i = 0; i < input.length; i++) {',
        '    for (let j = 0; j < input.length; j++) {',
        '      for (let k = 0; k < input.length; k++) {',
        '        acc += input[i] * input[j] - input[k];',
        '      }',
        '    }',
        '  }',
        '  return acc;',
        '}',
      ].join('\n'),
    );

    const issues = detector.detect(dir);
    const hit = issues.find((i) => i.ruleId === 'complexity.nested-loop');
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe('medium');
    expect(hit?.category).toBe('complexity');
    expect(hit?.file).toBe('src/services/heavy.ts');
    expect(hit?.message).toContain('3 层嵌套循环');
    expect(hit?.message).toMatch(CJK_RE);
    expect(hit?.autoFixable).toBe(false);
  });

  it('readFileSync + writeFileSync → sync-io issues (high)', () => {
    const dir = tmpDir('zh-perf-sync-io-');
    writeFile(
      dir,
      'src/utils/legacy.ts',
      [
        "import * as fs from 'fs';",
        'export function readConfig() {',
        '  return fs.readFileSync("/etc/config.json", "utf8");',
        '}',
        'export function writeResult(data: string) {',
        '  fs.writeFileSync("/tmp/output.txt", data);',
        '}',
      ].join('\n'),
    );

    const issues = detector.detect(dir);
    const syncIssues = issues.filter((i) => i.ruleId === 'complexity.sync-io');
    expect(syncIssues.length).toBeGreaterThanOrEqual(2);

    const readHit = syncIssues.find((i) => i.id.includes('readFileSync'));
    expect(readHit).toBeDefined();
    expect(readHit?.severity).toBe('high');
    expect(readHit?.category).toBe('complexity');
    expect(readHit?.file).toBe('src/utils/legacy.ts');

    const writeHit = syncIssues.find((i) => i.id.includes('writeFileSync'));
    expect(writeHit).toBeDefined();
    expect(writeHit?.severity).toBe('high');
  });

  it('clean file with simple code → no issues', () => {
    const dir = tmpDir('zh-perf-clean-');
    writeFile(
      dir,
      'src/app.ts',
      [
        'export function greet(name: string): string {',
        '  return `Hello, ${name}!`;',
        '}',
      ].join('\n'),
    );

    const issues = detector.detect(dir);
    expect(issues).toHaveLength(0);
  });

  it('non-existent src dir → empty array, no throw', () => {
    const dir = tmpDir('zh-perf-nosrc-');
    expect(() => detector.detect(dir)).not.toThrow();
    expect(detector.detect(dir)).toEqual([]);
  });

  it('两层嵌套循环不触发 nested-loop', () => {
    const dir = tmpDir('zh-perf-2loop-');
    writeFile(
      dir,
      'src/two.ts',
      [
        'export function twoLoop(data: number[]) {',
        '  for (let i = 0; i < data.length; i++) {',
        '    for (let j = 0; j < data.length; j++) {',
        '      console.log(data[i] + data[j]);',
        '    }',
        '  }',
        '}',
      ].join('\n'),
    );

    const issues = detector.detect(dir);
    expect(issues.some((i) => i.ruleId === 'complexity.nested-loop')).toBe(false);
  });

  it('注释中的 readFileSync 不触发 sync-io', () => {
    const dir = tmpDir('zh-perf-comment-');
    writeFile(
      dir,
      'src/commented.ts',
      [
        '// fs.readFileSync("secret.txt", "utf8");',
        'export function safe(): string {',
        '  return "no sync IO";',
        '}',
      ].join('\n'),
    );

    const issues = detector.detect(dir);
    expect(issues).toHaveLength(0);
  });

  it('while 和 do-while 三层嵌套也触发 nested-loop', () => {
    const dir = tmpDir('zh-perf-while-');
    writeFile(
      dir,
      'src/while.ts',
      [
        'export function whileNested(data: number[]) {',
        '  let i = 0;',
        '  while (i < data.length) {',
        '    let j = 0;',
        '    do {',
        '      let k = 0;',
        '      while (k < data.length) {',
        '        console.log(data[i] + data[j] + data[k]);',
        '        k++;',
        '      }',
        '      j++;',
        '    } while (j < data.length);',
        '    i++;',
        '  }',
        '}',
      ].join('\n'),
    );

    const issues = detector.detect(dir);
    const hit = issues.find((i) => i.ruleId === 'complexity.nested-loop');
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe('medium');
  });

  it('问题对象形状完整', () => {
    const dir = tmpDir('zh-perf-shape-');
    writeFile(
      dir,
      'src/bad.ts',
      [
        'export function deep(data: number[]) {',
        '  for (let i = 0; i < data.length; i++) {',
        '    for (let j = 0; j < data.length; j++) {',
        '      for (let k = 0; k < data.length; k++) {',
        '        console.log(data[i] + data[j] + data[k]);',
        '      }',
        '    }',
        '  }',
        '}',
      ].join('\n'),
    );

    const issues = detector.detect(dir);
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(typeof issue.id).toBe('string');
      expect(typeof issue.ruleId).toBe('string');
      expect(issue.category).toBe('complexity');
      expect(['medium', 'high']).toContain(issue.severity);
      expect(typeof issue.file).toBe('string');
      expect(typeof issue.message).toBe('string');
      expect(issue.message).toMatch(CJK_RE);
      expect(typeof issue.suggestion).toBe('string');
      expect(issue.autoFixable).toBe(false);
    }
  });
});
