import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanGarbage, cleanGarbage, restoreGarbage } from '../garbage-scanner';
import type { GarbageItem } from '../types';

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zh-clean-'));
}

describe('cleanGarbage', () => {
  it('moves selected files into .zhshield/trash and removes originals', async () => {
    const dir = tmpProject();
    fs.writeFileSync(path.join(dir, 'debug.log'), 'x');
    fs.writeFileSync(path.join(dir, 'keep.ts'), 'ok');
    const items = (await scanGarbage(dir)).filter((i) => i.path.endsWith('debug.log'));

    const result = cleanGarbage(dir, items);

    expect(result.cleaned).toHaveLength(1);
    expect(result.failed).toHaveLength(0);
    expect(fs.existsSync(path.join(dir, 'debug.log'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.zhshield', 'trash', result.batchId, 'debug.log'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'keep.ts'))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('skips unused-dependency entries', async () => {
    const dir = tmpProject();
    const dep: GarbageItem = { id: 'd1', type: 'unused-dependency', path: 'lodash', size: 0, reason: 'Unused' };

    const result = cleanGarbage(dir, [dep]);

    expect(result.cleaned).toHaveLength(0);
    expect(result.batchId).toBe('');
    expect(result.failed.some((m) => m.includes('unused-dependency'))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rejects path traversal outside the project', async () => {
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

  it('keeps trash batch dir empty on full failure', async () => {
    const dir = tmpProject();
    const result = cleanGarbage(dir, [
      { id: 'm1', type: 'unused-file', path: 'missing.log', size: 1, reason: 'x' },
    ]);
    expect(result.batchId).toBe('');
    expect(result.failed).toHaveLength(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('restoreGarbage', () => {
  it('restores files to their original location and removes the batch', async () => {
    const dir = tmpProject();
    fs.writeFileSync(path.join(dir, 'tmp.bak'), 'x');
    const items = (await scanGarbage(dir)).filter((i) => i.path.endsWith('tmp.bak'));
    const clean = cleanGarbage(dir, items);
    expect(fs.existsSync(path.join(dir, 'tmp.bak'))).toBe(false);

    const restored = restoreGarbage(dir, clean.batchId);

    expect(restored.restored).toBe(1);
    expect(fs.existsSync(path.join(dir, 'tmp.bak'))).toBe(true);
    expect(fs.existsSync(path.join(dir, '.zhshield', 'trash', clean.batchId))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('skips restore when a file already exists at the original path', async () => {
    const dir = tmpProject();
    fs.writeFileSync(path.join(dir, 'old.tmp'), 'x');
    const items = (await scanGarbage(dir)).filter((i) => i.path.endsWith('old.tmp'));
    const clean = cleanGarbage(dir, items);
    fs.writeFileSync(path.join(dir, 'old.tmp'), 'user-new');

    const restored = restoreGarbage(dir, clean.batchId);

    expect(restored.restored).toBe(0);
    expect(restored.failed.some((m) => m.includes('已有文件'))).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'old.tmp'), 'utf-8')).toBe('user-new');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('throws for a missing batch', () => {
    const dir = tmpProject();
    expect(() => restoreGarbage(dir, 'nonexistent-batch')).toThrow();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
