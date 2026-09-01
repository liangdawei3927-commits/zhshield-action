import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { FileHelper } from '../file';
import { PathTraversalError } from '@zh/shared';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('FileHelper', () => {
  const tmpDir = path.join(os.tmpdir(), 'zh-test-' + Date.now());

  beforeAll(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });
  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

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

  it('glob: 按 glob 语义匹配相对路径（a*b*c* 同时命中 abc.txt 与 a-b-c.txt）', async () => {
    fs.mkdirSync(path.join(tmpDir, 'glob'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'glob', 'a-b-c.txt'), 'x');
    fs.writeFileSync(path.join(tmpDir, 'glob', 'abc.txt'), 'x');
    fs.writeFileSync(path.join(tmpDir, 'glob', 'other.log'), 'x');

    // picomatch 做全量匹配（anchored），* 匹配任意非 / 字符，因此 'a*b*c*' 同时命中 abc.txt 与 a-b-c.txt
    const hits = await FileHelper.glob('a*b*c*', path.join(tmpDir, 'glob'));
    expect(hits).toContain(path.join(tmpDir, 'glob', 'abc.txt'));
    expect(hits).toContain(path.join(tmpDir, 'glob', 'a-b-c.txt'));
    expect(hits).not.toContain(path.join(tmpDir, 'glob', 'other.log'));
  });

  it('glob: 跳过噪声目录（node_modules/dist 等）与点开头目录', async () => {
    const dir = path.join(tmpDir, 'glob-noise');
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'keep.ts'), 'x');
    fs.writeFileSync(path.join(dir, 'node_modules', 'pkg', 'skip.ts'), 'x');
    fs.writeFileSync(path.join(dir, 'dist', 'skip.ts'), 'x');
    fs.writeFileSync(path.join(dir, '.git', 'skip.ts'), 'x');

    const hits = await FileHelper.glob('**/*.ts', dir);
    expect(hits).toContain(path.join(dir, 'src', 'keep.ts'));
    expect(hits).not.toContain(path.join(dir, 'node_modules', 'pkg', 'skip.ts'));
    expect(hits).not.toContain(path.join(dir, 'dist', 'skip.ts'));
    expect(hits).not.toContain(path.join(dir, '.git', 'skip.ts'));
  });

  it('glob: 路径穿越条目（.. / 绝对路径注入）无法逃出 dir', async () => {
    const dir = path.join(tmpDir, 'glob-traversal');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'ok.txt'), 'x');

    const realReaddir = fs.promises.readdir.bind(fs.promises);
    const spy = vi.spyOn(fs.promises, 'readdir').mockImplementation((async (
      p: fs.PathLike,
      opts?: fs.ReaddirOptions,
    ) => {
      if (String(p) === dir) {
        return [
          { name: '..', isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false },
          {
            name: '/etc/passwd',
            isDirectory: () => false,
            isFile: () => true,
            isSymbolicLink: () => false,
          },
          {
            name: 'ok.txt',
            isDirectory: () => false,
            isFile: () => true,
            isSymbolicLink: () => false,
          },
        ] as fs.Dirent[];
      }
      return realReaddir(p, opts) as Promise<fs.Dirent[]>;
    }) as typeof fs.promises.readdir);

    try {
      await expect(FileHelper.glob('*', dir)).rejects.toThrow(PathTraversalError);
    } finally {
      spy.mockRestore();
    }
  });
});
