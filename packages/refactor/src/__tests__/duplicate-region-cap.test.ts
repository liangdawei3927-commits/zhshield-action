import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RefactorEngine } from '../engine';
import { countSmellsByFileAndRule } from '../baseline';

// 回归锁：数据路径不得对重复区设上限。修复前 scanDuplicateCodeBlocks 截断到 50，
// 消除一处真实重复会移动截断窗口、把存量重复区挤进计数集，导致 ratchet 假阳性。
const REGION_COUNT = 60;

function duplicatedBlock(k: number): string {
  return [
    `const alpha${k} = computeAlpha${k}(input${k});`,
    `const beta${k} = computeBeta${k}(alpha${k});`,
    `if (beta${k} > threshold${k}) {`,
    `  return beta${k} * factor${k};`,
    `}`,
    `return alpha${k} + beta${k};`,
  ].join('\n');
}

function buildFixture(prefix: 'a' | 'b'): string {
  const parts: string[] = [];
  for (let k = 0; k < REGION_COUNT; k++) {
    parts.push(duplicatedBlock(k));
    // 分隔行两侧不同，避免跨块滑窗被误配成额外重复区
    const sep = prefix === 'a' ? k * 7 + 1 : k * 13 + 2;
    parts.push(`const ${prefix}Sep${k} = ${sep};`);
  }
  return parts.join('\n') + '\n';
}

describe('duplicated-code 数据路径不设上限 (TDD 回归)', () => {
  let tmpDir: string;
  let fileA: string;
  let fileB: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zh-dup-cap-'));
    fileA = path.join(tmpDir, 'dup-cap-a.ts');
    fileB = path.join(tmpDir, 'dup-cap-b.ts');
    fs.writeFileSync(fileA, buildFixture('a'));
    fs.writeFileSync(fileB, buildFixture('b'));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('超过 50 个重复区时，countSmellsByFileAndRule 报告每个参与文件的完整计数', async () => {
    const engine = new RefactorEngine({ enabledRules: ['duplicated-code'] });
    const report = await engine.analyzeFiles(tmpDir, [fileA, fileB]);
    const counts = countSmellsByFileAndRule(report, tmpDir);

    const relA = path.relative(tmpDir, fileA).replace(/\\/g, '/');
    const relB = path.relative(tmpDir, fileB).replace(/\\/g, '/');

    // 修复前：截断到 50 个重复区 → 每文件 50 条（其中一文件因截断提示 +1）。
    // 断言两侧都 > 50，确保任一文件被截断都会失败。
    expect(counts[relA]['duplicated-code']).toBeGreaterThan(50);
    expect(counts[relB]['duplicated-code']).toBeGreaterThan(50);
  });
});
