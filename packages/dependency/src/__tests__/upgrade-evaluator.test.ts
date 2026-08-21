import { describe, expect, it, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UpgradeEvaluatorImpl, DEFAULT_UPGRADE_CATALOG, type UpgradeCatalog } from '../adapters/upgrade-evaluator';
import type { DependencyNode } from '../types';

/** 创建临时目录并登记清理（沿用 graph-builder.test.ts 约定） */
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

/** 构造最小依赖节点 */
function makeNode(name: string, version: string): DependencyNode {
  return {
    id: `${name}@${version}`,
    name,
    version,
    declaredRange: '',
    kind: 'direct',
    trust: 'unknown',
    vulnerabilities: [],
  };
}

const evaluator = new UpgradeEvaluatorImpl();

describe('UpgradeEvaluatorImpl 候选生成', () => {
  it('react 17 => 候选 18/19，nodeId 正确', async () => {
    const assessment = await evaluator.evaluate(makeNode('react', '17.0.2'));

    expect(assessment.nodeId).toBe('react@17.0.2');
    expect(assessment.candidates.map((c) => c.targetVersion)).toEqual(['18', '19']);
  });

  it('未知包 => 空候选，不抛异常', async () => {
    const assessment = await evaluator.evaluate(makeNode('totally-unknown-pkg', '1.0.0'));

    expect(assessment.candidates).toEqual([]);
  });

  it('当前版本已是最新 => 空候选', async () => {
    const assessment = await evaluator.evaluate(makeNode('react', '19.0.0'));

    expect(assessment.candidates).toEqual([]);
  });

  it('目录注入：securityRelevant 置顶，低风险先于高风险', async () => {
    const catalog: UpgradeCatalog = {
      react: [
        { targetVersion: '18', risk: 'low', securityRelevant: false, reason: '低风险升级', breakingChanges: [] },
        { targetVersion: '19', risk: 'high', securityRelevant: true, reason: '修复漏洞', breakingChanges: [] },
      ],
    };
    const injected = new UpgradeEvaluatorImpl(catalog);

    const assessment = await injected.evaluate(makeNode('react', '17.0.2'));

    expect(assessment.candidates.map((c) => c.targetVersion)).toEqual(['19', '18']);
    expect(assessment.candidates[0].securityRelevant).toBe(true);
  });

  it('目录注入：无 securityRelevant 时低风险先于高风险', async () => {
    const catalog: UpgradeCatalog = {
      react: [
        { targetVersion: '18', risk: 'medium', securityRelevant: false, reason: '中风险', breakingChanges: [] },
        { targetVersion: '19', risk: 'low', securityRelevant: false, reason: '低风险', breakingChanges: [] },
      ],
    };
    const injected = new UpgradeEvaluatorImpl(catalog);

    const assessment = await injected.evaluate(makeNode('react', '17.0.2'));

    expect(assessment.candidates.map((c) => c.targetVersion)).toEqual(['19', '18']);
  });

  it('目录注入：同风险时落后最久者优先', async () => {
    const catalog: UpgradeCatalog = {
      react: [
        { targetVersion: '18', risk: 'low', securityRelevant: false, reason: '落后1个大版本', breakingChanges: [] },
        { targetVersion: '19', risk: 'low', securityRelevant: false, reason: '落后2个大版本', breakingChanges: [] },
      ],
    };
    const injected = new UpgradeEvaluatorImpl(catalog);

    const assessment = await injected.evaluate(makeNode('react', '17.0.2'));

    expect(assessment.candidates.map((c) => c.targetVersion)).toEqual(['19', '18']);
  });

  it('lodash 4.17.20 => 安全修复候选（4.17.21）置顶且 securityRelevant', async () => {
    const assessment = await evaluator.evaluate(makeNode('lodash', '4.17.20'));

    expect(assessment.candidates).toHaveLength(1);
    expect(assessment.candidates[0].targetVersion).toBe('4.17.21');
    expect(assessment.candidates[0].securityRelevant).toBe(true);
    expect(assessment.candidates[0].breakingChanges.length).toBeGreaterThan(0);
  });
});

describe('UpgradeEvaluatorImpl code-scan（affectedFiles）', () => {
  it('projectRoot 指向含 src/index.ts import 该包的 fixture => 收集受影响文件', async () => {
    const dir = tmpDir('zh-upg-scan-');
    writeFile(dir, 'src/index.ts', "import { createRoot } from 'react';\n");
    writeFile(dir, 'src/other.ts', 'const x = 1;\n');

    const assessment = await evaluator.evaluate(makeNode('react', '17.0.2'), { projectRoot: dir });

    for (const candidate of assessment.candidates) {
      expect(candidate.breakingChanges[0].affectedFiles).toEqual(['src/index.ts']);
    }
  });

  it('scanLimit 约束扫描文件数：5 个 import 文件，limit 2 => 最多收集 2 个', async () => {
    const dir = tmpDir('zh-upg-limit-');
    for (let i = 0; i < 5; i++) {
      writeFile(dir, `src/f${i}.ts`, `import 'react';\n`);
    }

    const assessment = await evaluator.evaluate(makeNode('react', '17.0.2'), {
      projectRoot: dir,
      scanLimit: 2,
    });

    const affected = assessment.candidates[0].breakingChanges[0].affectedFiles;
    expect(affected.length).toBeLessThanOrEqual(2);
  });

  it('扫描跳过 node_modules（含 src 下的 node_modules）', async () => {
    const dir = tmpDir('zh-upg-skip-');
    writeFile(dir, 'src/index.ts', "import 'react';\n");
    writeFile(dir, 'src/node_modules/react/evil.js', "import 'react';\n");
    writeFile(dir, 'src/vendor/index.js', "import 'react';\n");
    writeFile(dir, 'src/vendor/node_modules/react/evil.js', "import 'react';\n");

    const assessment = await evaluator.evaluate(makeNode('react', '17.0.2'), { projectRoot: dir });

    const affected = assessment.candidates[0].breakingChanges[0].affectedFiles;
    expect(affected).toEqual(['src/index.ts', 'src/vendor/index.js']);
  });

  it('未提供 projectRoot => affectedFiles 为空数组', async () => {
    const assessment = await evaluator.evaluate(makeNode('react', '17.0.2'));

    for (const candidate of assessment.candidates) {
      for (const change of candidate.breakingChanges) {
        expect(change.affectedFiles).toEqual([]);
      }
    }
  });

  it('scanLimit=0 => 不执行扫描，affectedFiles 为空数组', async () => {
    const dir = tmpDir('zh-upg-zero-');
    writeFile(dir, 'src/index.ts', "import 'react';\n");

    const assessment = await evaluator.evaluate(makeNode('react', '17.0.2'), { projectRoot: dir, scanLimit: 0 });

    for (const candidate of assessment.candidates) {
      expect(candidate.breakingChanges[0].affectedFiles).toEqual([]);
    }
  });

  it('项目无 src 目录 => affectedFiles 为空数组，不抛异常', async () => {
    const dir = tmpDir('zh-upg-nosrc-');
    writeFile(dir, 'index.js', "import 'react';\n");

    const assessment = await evaluator.evaluate(makeNode('react', '17.0.2'), { projectRoot: dir });

    expect(assessment.candidates[0].breakingChanges[0].affectedFiles).toEqual([]);
  });

  it('默认目录覆盖 >=8 个知名包', () => {
    const names = Object.keys(DEFAULT_UPGRADE_CATALOG);
    expect(names.length).toBeGreaterThanOrEqual(8);
    expect(names).toEqual(expect.arrayContaining(['react', 'vue', 'lodash', 'express', 'webpack', 'typescript', 'vite', 'axios']));
  });
});
