import { describe, expect, it, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveProjectRoot } from '../adapters/project-root';

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

describe('resolveProjectRoot', () => {
  it('目录自身含锁文件 → 原样返回自身', () => {
    const dir = tmpDir('zh-root-self-');
    writeFile(dir, 'pnpm-lock.yaml', 'lockfileVersion: \'9.0\'\n');
    expect(resolveProjectRoot(dir)).toBe(path.resolve(dir));
  });

  it('子目录不含锁文件、父目录含 → 向上解析到父目录（workspace 子包场景）', () => {
    const root = tmpDir('zh-root-up1-');
    const sub = path.join(root, 'packages', 'desktop');
    fs.mkdirSync(sub, { recursive: true });
    writeFile(sub, 'package.json', '{}');
    writeFile(root, 'pnpm-lock.yaml', 'lockfileVersion: \'9.0\'\n');
    expect(resolveProjectRoot(sub)).toBe(path.resolve(root));
  });

  it('向上多层找到最近含锁文件祖先（嵌套 workspace 场景）', () => {
    const root = tmpDir('zh-root-upn-');
    const nested = path.join(root, 'a', 'b', 'c');
    fs.mkdirSync(nested, { recursive: true });
    writeFile(root, 'yarn.lock', '# yaml');
    expect(resolveProjectRoot(nested)).toBe(path.resolve(root));
  });

  it('近层祖先与远层祖先都含锁文件 → 取最近的', () => {
    const root = tmpDir('zh-root-nearest-');
    const mid = path.join(root, 'mid');
    const deep = path.join(mid, 'deep');
    fs.mkdirSync(deep, { recursive: true });
    writeFile(root, 'package-lock.json', '{}');
    writeFile(mid, 'pnpm-lock.yaml', 'lockfileVersion: \'9.0\'\n');
    expect(resolveProjectRoot(deep)).toBe(path.resolve(mid));
  });

  it('当前目录含锁文件时不向上误解析（即使父级也有）', () => {
    const root = tmpDir('zh-root-no-up-');
    const sub = path.join(root, 'sub');
    fs.mkdirSync(sub, { recursive: true });
    writeFile(root, 'pnpm-lock.yaml', 'lockfileVersion: \'9.0\'\n');
    writeFile(sub, 'pnpm-lock.yaml', 'lockfileVersion: \'9.0\'\n');
    expect(resolveProjectRoot(sub)).toBe(path.resolve(sub));
  });

  it('向上与向下都找不到锁文件 → 原样返回（诚实保留缺失判定）', () => {
    const dir = tmpDir('zh-root-none-');
    const nested = path.join(dir, 'x', 'y');
    fs.mkdirSync(nested, { recursive: true });
    expect(resolveProjectRoot(nested)).toBe(path.resolve(nested));
  });

  it('扫描父目录且唯一直接子目录含锁文件 → 向下解析到该子目录', () => {
    const parent = tmpDir('zh-root-down1-');
    const child = path.join(parent, 'project-a');
    fs.mkdirSync(child, { recursive: true });
    writeFile(child, 'pnpm-lock.yaml', 'lockfileVersion: \'9.0\'\n');
    expect(resolveProjectRoot(parent)).toBe(path.resolve(child));
  });

  it('父目录下多个直接子目录含锁文件 → 不猜测，原样返回父目录', () => {
    const parent = tmpDir('zh-root-downn-');
    for (const name of ['a', 'b']) {
      const child = path.join(parent, name);
      fs.mkdirSync(child, { recursive: true });
      writeFile(child, 'pnpm-lock.yaml', 'lockfileVersion: \'9.0\'\n');
    }
    expect(resolveProjectRoot(parent)).toBe(path.resolve(parent));
  });
});