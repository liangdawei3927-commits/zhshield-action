import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RefactorEngine } from '../engine';
import { isWithinProject } from '../auto-fix-apply';

/**
 * 「一键应用自动修复」的验收：改文件前必须备份、只改可自动修复项、可重复调用。
 */
describe('RefactorEngine.applyAutoFixes', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'autofix-'));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('应用封装性修复：字段转 private，且写盘前已备份原文件', async () => {
    const file = path.join(root, 'src', 'foo.ts');
    const original =
      'export class Foo {\n' +
      '  public a: string = "";\n' +
      '  public b: string = "";\n' +
      '  public c: string = "";\n' +
      '  public d: string = "";\n' +
      '}\n';
    fs.writeFileSync(file, original, 'utf-8');

    const result = await new RefactorEngine().applyAutoFixes(root);

    expect(result.fixCount).toBeGreaterThanOrEqual(1);
    expect(result.applied).toBe(true);
    expect(result.backupDir).toBeTruthy();

    // 备份内容与原文件逐字节一致（可原样回滚）
    const rel = result.backedUpFiles.find((f) => f.endsWith('foo.ts'));
    expect(rel).toBeTruthy();
    const backup = fs.readFileSync(path.join(result.backupDir as string, rel as string), 'utf-8');
    expect(backup).toBe(original);

    // 现文件已被改写为 private
    const now = fs.readFileSync(file, 'utf-8');
    expect(now).toContain('private a');
    expect(now).not.toContain('public a');
  });

  it('没有可自动修复问题时返回 applied:false 且带说明（不改盘）', async () => {
    const file = path.join(root, 'src', 'ok.ts');
    const original = 'export const x = 1;\n';
    fs.writeFileSync(file, original, 'utf-8');

    const result = await new RefactorEngine().applyAutoFixes(root);

    expect(result.applied).toBe(false);
    expect(result.fixCount).toBe(0);
    expect(result.message).toBeTruthy();
    // 未改动文件
    expect(fs.readFileSync(file, 'utf-8')).toBe(original);
  });
});

/**
 * 写盘硬前置的判定（代码审查报告3 P2-2）：
 * 越界目标必须拒绝写入；且目录名恰为 `..foo` 的合法路径不得被误判越界。
 */
describe('isWithinProject', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'within-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('项目根内的普通文件 → true', () => {
    expect(isWithinProject(path.join(root, 'src', 'a.ts'), root)).toBe(true);
  });

  it('项目根自身（相对路径为空）→ false', () => {
    expect(isWithinProject(root, root)).toBe(false);
  });

  it('逃逸到父目录或系统绝对路径 → false', () => {
    expect(isWithinProject(path.join(path.dirname(root), 'evil.ts'), root)).toBe(false);
    if (path.parse(root).root !== root) {
      expect(isWithinProject(path.join(path.parse(root).root, 'etc', 'passwd'), root)).toBe(false);
    }
  });

  it('目录名恰为 `..foo` 的合法路径不会被误判越界（回归）', () => {
    // 旧实现用 startsWith('..') 会把这判成越界，导致"跳过备份但仍写入"
    expect(isWithinProject(path.join(root, '..foo', 'a.ts'), root)).toBe(true);
  });
});
