import { describe, expect, it, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DependencyNode } from '@zh/dependency';
import {
  depsBaselinePath,
  loadDepsBaseline,
  saveDepsBaseline,
  integritySnapshot,
  extractMismatchedNodeIds,
  applyMismatchedTrust,
} from '../../electron/ipc/deps-baseline';

const dirs: string[] = [];
function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
});

function node(id: string, partial: Partial<DependencyNode> = {}): DependencyNode {
  return {
    id,
    name: id.split('@')[0],
    version: id.split('@')[1] ?? '',
    declaredRange: '^1.0.0',
    kind: 'direct',
    trust: 'verified',
    vulnerabilities: [],
    ...partial,
  };
}

describe('deps-baseline 读写', () => {
  it('写入后可从同路径读回；捕获时间戳存在', () => {
    const root = tmpDir('zh-baseline-ok-');
    const baseline = saveDepsBaseline(root, { 'lodash@4.17.21': 'sha512-x', 'react@18.2.0': 'sha512-y' });

    expect(baseline.version).toBe(1);
    expect(fs.existsSync(depsBaselinePath(root))).toBe(true);
    expect(fs.existsSync(`${depsBaselinePath(root)}.${process.pid}.tmp`)).toBe(false);

    const loaded = loadDepsBaseline(root);
    expect(loaded).not.toBeNull();
    expect(loaded!.integrity).toEqual({ 'lodash@4.17.21': 'sha512-x', 'react@18.2.0': 'sha512-y' });
    expect(loaded!.capturedAt).toBe(baseline.capturedAt);
  });

  it('原子写：.zhshield 目录自动创建', () => {
    const root = tmpDir('zh-baseline-mkdir-');
    saveDepsBaseline(root, {});
    expect(fs.statSync(path.join(root, '.zhshield')).isDirectory()).toBe(true);
  });

  it('损坏文件 → null（降级为无基线）', () => {
    const root = tmpDir('zh-baseline-corrupt-');
    fs.mkdirSync(path.join(root, '.zhshield'), { recursive: true });
    fs.writeFileSync(depsBaselinePath(root), '{not json');

    expect(loadDepsBaseline(root)).toBeNull();
  });

  it('版本不符 / 结构缺失 → null', () => {
    const root = tmpDir('zh-baseline-badshape-');
    fs.mkdirSync(path.join(root, '.zhshield'), { recursive: true });
    fs.writeFileSync(depsBaselinePath(root), JSON.stringify({ version: 999, capturedAt: 'x', integrity: {} }));

    expect(loadDepsBaseline(root)).toBeNull();

    fs.writeFileSync(depsBaselinePath(root), JSON.stringify({ version: 1, integrity: {} }));
    expect(loadDepsBaseline(root)).toBeNull();
  });

  it('文件不存在 → null', () => {
    const root = tmpDir('zh-baseline-missing-');
    expect(loadDepsBaseline(root)).toBeNull();
  });
});

describe('deps-baseline 快照与比对', () => {
  it('integritySnapshot 仅含带哈希的节点', () => {
    const snapshot = integritySnapshot([
      node('lodash@4.17.21', { integrity: 'sha512-x' }),
      node('react@18.2.0'),
    ]);

    expect(snapshot).toEqual({ 'lodash@4.17.21': 'sha512-x' });
  });

  it('extractMismatchedNodeIds 匹配「校验和不匹配」并忽略其他失败', () => {
    const ids = extractMismatchedNodeIds([
      '[npm] lodash@4.17.21 校验和不匹配：期望 a，实际 b',
      '[npm] react@18.2.0 缺失',
      '[npm] typescript 无法解析',
    ]);

    expect(ids).toEqual(['lodash@4.17.21']);
  });

  it('applyMismatchedTrust：命中节点 → compromised，其他不变且原数组不被修改', () => {
    const original = [node('lodash@4.17.21'), node('react@18.2.0', { integrity: 'sha512-y' })];
    const result = applyMismatchedTrust(original, ['lodash@4.17.21']);

    expect(result[0].trust).toBe('compromised');
    expect(result[1].trust).toBe('verified');
    expect(original[0].trust).toBe('verified');
    expect(original[1]).toBe(result[1]);
  });

  it('applyMismatchedTrust：空 mismatch → 返回新数组且 trust 全部保留', () => {
    const original = [node('lodash@4.17.21', { trust: 'suspicious' })];
    const result = applyMismatchedTrust(original, []);

    expect(result).not.toBe(original);
    expect(result[0].trust).toBe('suspicious');
  });
});