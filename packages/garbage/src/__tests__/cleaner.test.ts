import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectFsGarbage } from '../fs-detector';
import { cleanGarbage, restoreGarbage } from '../cleaner';
import type { GarbageItem } from '../types';

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zh-clean-'));
}

describe('cleanGarbage', () => {
  it('把选中的文件移入 .zhshield/trash 并移除原文件', async () => {
    const dir = tmpProject();
    fs.writeFileSync(path.join(dir, 'debug.log'), 'x');
    fs.writeFileSync(path.join(dir, 'keep.ts'), 'ok');
    const items = (await detectFsGarbage(dir)).filter((i) => i.path.endsWith('debug.log'));

    const result = cleanGarbage(dir, items);

    expect(result.cleaned).toHaveLength(1);
    expect(result.failed).toHaveLength(0);
    expect(fs.existsSync(path.join(dir, 'debug.log'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.zhshield', 'trash', result.batchId, 'debug.log'))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(dir, 'keep.ts'))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('把构建产物目录整体移入回收站', async () => {
    const dir = tmpProject();
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'dist', 'bundle.js'), 'x'.repeat(1024));
    const items = (await detectFsGarbage(dir)).filter((i) => i.type === 'build-artifact');

    const result = cleanGarbage(dir, items);

    expect(result.cleaned).toHaveLength(1);
    expect(result.failed).toHaveLength(0);
    expect(fs.existsSync(path.join(dir, 'dist'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.zhshield', 'trash', result.batchId, 'dist'))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('跳过 unused-dependency（需包管理器移除，不在文件级清理范围）', () => {
    const dir = tmpProject();
    const dep: GarbageItem = {
      id: 'd1',
      type: 'unused-dependency',
      path: 'lodash',
      size: 0,
      reason: 'Unused',
    };

    const result = cleanGarbage(dir, [dep]);

    expect(result.cleaned).toHaveLength(0);
    expect(result.batchId).toBe('');
    expect(result.failed.some((m) => m.includes('unused-dependency'))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('拒绝越界路径，不移动项目外文件', () => {
    const dir = tmpProject();
    const outside = path.join(os.tmpdir(), `zh-outside-${Date.now()}`);
    fs.writeFileSync(outside, 'x');

    const result = cleanGarbage(dir, [
      { id: 'e1', type: 'unused-file', path: `../${path.basename(outside)}`, size: 1, reason: 'x' },
    ]);

    expect(result.cleaned).toHaveLength(0);
    expect(result.failed.some((m) => m.includes('越界'))).toBe(true);
    expect(fs.existsSync(outside)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { force: true });
  });

  it('全部失败时不留下空的批次目录', () => {
    const dir = tmpProject();
    const result = cleanGarbage(dir, [
      { id: 'm1', type: 'unused-file', path: 'missing.log', size: 1, reason: 'x' },
    ]);
    expect(result.batchId).toBe('');
    expect(result.failed).toHaveLength(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('拒绝经符号链接指向 base 外的清理目标', () => {
    const dir = tmpProject();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'zh-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
      fs.symlinkSync(outside, path.join(dir, 'link'));

      const result = cleanGarbage(dir, [
        { id: 's1', type: 'unused-file', path: 'link/secret.txt', size: 1, reason: 'x' },
      ]);

      expect(result.cleaned).toHaveLength(0);
      expect(result.failed.some((m) => m.includes('link/secret.txt'))).toBe(true);
      expect(fs.existsSync(path.join(outside, 'secret.txt'))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('restoreGarbage', () => {
  it('恢复到原始位置并清理批次目录', async () => {
    const dir = tmpProject();
    fs.writeFileSync(path.join(dir, 'tmp.bak'), 'x');
    const items = (await detectFsGarbage(dir)).filter((i) => i.path.endsWith('tmp.bak'));
    const clean = cleanGarbage(dir, items);
    expect(fs.existsSync(path.join(dir, 'tmp.bak'))).toBe(false);

    const restored = restoreGarbage(dir, clean.batchId);

    expect(restored.restored).toBe(1);
    expect(fs.existsSync(path.join(dir, 'tmp.bak'))).toBe(true);
    expect(fs.existsSync(path.join(dir, '.zhshield', 'trash', clean.batchId))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('原位置已有文件时跳过恢复，不覆盖用户新文件', async () => {
    const dir = tmpProject();
    fs.writeFileSync(path.join(dir, 'old.tmp'), 'x');
    const items = (await detectFsGarbage(dir)).filter((i) => i.path.endsWith('old.tmp'));
    const clean = cleanGarbage(dir, items);
    fs.writeFileSync(path.join(dir, 'old.tmp'), 'user-new');

    const restored = restoreGarbage(dir, clean.batchId);

    expect(restored.restored).toBe(0);
    expect(restored.failed.some((m) => m.includes('已有文件'))).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'old.tmp'), 'utf-8')).toBe('user-new');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('批次不存在时抛错', () => {
    const dir = tmpProject();
    expect(() => restoreGarbage(dir, 'nonexistent-batch')).toThrow();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('拒绝经符号链接把文件恢复到 base 之外', () => {
    const dir = tmpProject();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'zh-outside-'));
    try {
      fs.symlinkSync(outside, path.join(dir, 'link'));
      const batchId = 'escape-batch';
      const batchDir = path.join(dir, '.zhshield', 'trash', batchId);
      fs.mkdirSync(path.join(batchDir, 'link'), { recursive: true });
      fs.writeFileSync(path.join(batchDir, 'link', 'evil.txt'), 'x');

      const restored = restoreGarbage(dir, batchId);

      expect(fs.existsSync(path.join(outside, 'evil.txt'))).toBe(false);
      expect(restored.failed.some((m) => m.includes('link/evil.txt'))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('拒绝恢复 trash 内指向 base 外的符号链接条目', () => {
    const dir = tmpProject();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'zh-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
      const batchId = 'escape-batch-2';
      const batchDir = path.join(dir, '.zhshield', 'trash', batchId);
      fs.mkdirSync(batchDir, { recursive: true });
      fs.symlinkSync(outside, path.join(batchDir, 'link'));

      const restored = restoreGarbage(dir, batchId);

      expect(fs.existsSync(path.join(outside, 'secret.txt'))).toBe(true);
      expect(restored.failed.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
