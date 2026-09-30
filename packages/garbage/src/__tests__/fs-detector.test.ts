import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectFsGarbage } from '../fs-detector';

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zh-garbage-fs-'));
}

describe('detectFsGarbage', () => {
  it('把根级构建产物目录识别为单条（含体积）并识别垃圾文件', async () => {
    const dir = tmpProject();
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'coverage'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.cache'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'dist', 'bundle.js'), 'x'.repeat(20 * 1024));
    fs.writeFileSync(path.join(dir, 'coverage', 'lcov.info'), 'x'.repeat(15 * 1024));
    fs.writeFileSync(path.join(dir, '.cache', 'blob.bin'), 'x'.repeat(12 * 1024));
    fs.writeFileSync(path.join(dir, '.DS_Store'), 'x');
    fs.writeFileSync(path.join(dir, 'src', 'old.log'), 'x');

    const items = await detectFsGarbage(dir);

    const artifacts = items.filter((i) => i.type === 'build-artifact');
    expect(artifacts.map((i) => i.path).sort()).toEqual(['.cache', 'coverage', 'dist']);
    expect(artifacts.find((i) => i.path === 'dist')?.size).toBe(20 * 1024);
    expect(artifacts.find((i) => i.path === 'coverage')?.size).toBe(15 * 1024);
    expect(artifacts.find((i) => i.path === '.cache')?.size).toBe(12 * 1024);
    expect(artifacts.every((i) => i.reason.includes('构建产物'))).toBe(true);

    const junk = items.filter((i) => i.type === 'unused-file');
    expect(junk.map((i) => i.path).sort()).toEqual(['.DS_Store', 'src/old.log']);

    expect(items).toHaveLength(5);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('嵌套同名构建产物目录不算垃圾（仅根级）', async () => {
    const dir = tmpProject();
    fs.mkdirSync(path.join(dir, 'src', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'dist', 'bundle.js'), 'x'.repeat(1024));

    const items = await detectFsGarbage(dir);

    expect(items.filter((i) => i.type === 'build-artifact')).toHaveLength(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('识别空文件，但豁免常见入口名（main/index/app.*）', async () => {
    const dir = tmpProject();
    fs.writeFileSync(path.join(dir, 'placeholder.ts'), '');
    fs.writeFileSync(path.join(dir, 'index.ts'), '');
    fs.writeFileSync(path.join(dir, 'main.ts'), '');

    const items = await detectFsGarbage(dir);

    expect(items.map((i) => i.path)).toEqual(['placeholder.ts']);
    expect(items[0].size).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('跳过 node_modules / .git', async () => {
    const dir = tmpProject();
    fs.mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', 'pkg', 'a.log'), 'x');
    fs.writeFileSync(path.join(dir, '.git', 'HEAD.log'), 'x');
    fs.writeFileSync(path.join(dir, 'real.log'), 'x');

    const items = await detectFsGarbage(dir);

    expect(items.map((i) => i.path)).toEqual(['real.log']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('不扫描 .zhshield：自身状态与回收站都不计入（clean-must-not-inflate-count）', async () => {
    const dir = tmpProject();
    const trash = path.join(dir, '.zhshield', 'trash', 'batch-1', 'packages', 'a', '.turbo');
    fs.mkdirSync(trash, { recursive: true });
    fs.writeFileSync(path.join(trash, 'turbo-build.log'), 'x');
    fs.writeFileSync(path.join(dir, '.zhshield', 'diagnostics.log'), 'x');
    fs.writeFileSync(path.join(dir, 'real.log'), 'x');

    const items = await detectFsGarbage(dir);

    expect(items.map((i) => i.path)).toEqual(['real.log']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('忽略嵌套层 .turbo：既不展开也不把其日志算成垃圾（build-must-not-grow-count）', async () => {
    const dir = tmpProject();
    fs.mkdirSync(path.join(dir, 'packages', 'a', '.turbo', 'cache'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'packages', 'a', 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'packages', 'a', '.turbo', 'turbo-build.log'), 'x');
    fs.writeFileSync(path.join(dir, 'packages', 'a', '.turbo', 'cache', 'x.tar.zst'), 'x');
    fs.writeFileSync(path.join(dir, 'packages', 'a', 'src', 'index.ts'), 'x');

    const items = await detectFsGarbage(dir);

    expect(items).toHaveLength(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('根级 .turbo 仍作为可清理构建产物上报（不因忽略规则丢失能力）', async () => {
    const dir = tmpProject();
    fs.mkdirSync(path.join(dir, '.turbo', 'cache'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.turbo', 'turbo-build.log'), 'x');

    const items = await detectFsGarbage(dir);

    expect(items.map((i) => ({ t: i.type, p: i.path }))).toEqual([
      { t: 'build-artifact', p: '.turbo' },
    ]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('统计构建产物体积时同样不递归 node_modules / .git（perf-walk-requires-ignore）', async () => {
    const dir = tmpProject();
    // 构建产物内嵌 node_modules：体积不应把它算进去（少报不虚报），且必须能快速返回
    fs.mkdirSync(path.join(dir, 'dist', 'node_modules', 'huge'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'dist', '.git'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'dist', 'bundle.js'), 'x'.repeat(4096));
    fs.writeFileSync(path.join(dir, 'dist', 'node_modules', 'huge', 'blob.bin'), 'x'.repeat(1024));
    fs.writeFileSync(path.join(dir, 'dist', '.git', 'pack.bin'), 'x'.repeat(2048));

    const items = await detectFsGarbage(dir);
    const dist = items.find((i) => i.path === 'dist');

    expect(dist?.type).toBe('build-artifact');
    // 只计 bundle.js；嵌在产物里的 node_modules / .git 不计入
    expect(dist?.size).toBe(4096);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
