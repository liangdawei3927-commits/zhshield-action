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

  it('glob: 剥离全部 * 后按子串匹配（多星号模式不再只替换首个）', async () => {
    fs.mkdirSync(path.join(tmpDir, 'glob'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'glob', 'a-b-c.txt'), 'x');
    fs.writeFileSync(path.join(tmpDir, 'glob', 'abc.txt'), 'x');
    fs.writeFileSync(path.join(tmpDir, 'glob', 'other.log'), 'x');

    // 模式 'a*b*c' 剥离全部 * 后为 'abc'：应命中 abc.txt，且不再命中 a-b-c.txt
    const hits = await FileHelper.glob('a*b*c', path.join(tmpDir, 'glob'));
    expect(hits).toContain(path.join(tmpDir, 'glob', 'abc.txt'));
    expect(hits).not.toContain(path.join(tmpDir, 'glob', 'a-b-c.txt'));
  });
});
