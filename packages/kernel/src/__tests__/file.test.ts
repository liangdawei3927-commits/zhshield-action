import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FileHelper } from '../file';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('FileHelper', () => {
  const tmpDir = path.join(os.tmpdir(), 'zh-test-' + Date.now());

  beforeAll(() => { fs.mkdirSync(tmpDir, { recursive: true }); });
  afterAll(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('should write and read JSON', async () => {
    const filePath = path.join(tmpDir, 'test.json');
    await FileHelper.writeJSON(filePath, { a: 1 });
    const data = await FileHelper.readJSON(filePath);
    expect(data).toEqual({ a: 1 });
  });

  it('should ensure directory exists', async () => {
    const dir = path.join(tmpDir, 'nested', 'deep');
    await FileHelper.ensureDir(dir);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('should check file existence', async () => {
    expect(await FileHelper.exists(path.join(tmpDir, 'test.json'))).toBe(true);
    expect(await FileHelper.exists(path.join(tmpDir, 'nope.json'))).toBe(false);
  });
});
