import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { SopRuleEngine } from '../runner';
import { SopRegistry } from '../sop/_meta/sop-registry';
import { makeRule } from './helpers/rule-factory';

describe('SopRuleEngine — 上下文过滤与边界场景', () => {
  let registry: SopRegistry;
  let engine: SopRuleEngine;
  let tempDir: string;

  beforeEach(() => {
    registry = new SopRegistry();
    engine = new SopRuleEngine(registry);
    tempDir = mkdtempSync(path.join(tmpdir(), 'rule-engine-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('无匹配规则时返回空报告', async () => {
    registry.register(
      makeRule({
        id: 'guard.some-rule',
        domain: 'guard',
        status: 'active',
      }),
    );

    // 过滤 domain 不存在的
    const report = await engine.evaluateRules({ repoRoot: '/tmp', domain: 'inspect' });
    expect(report.total).toBe(0);
    expect(report.ok).toBe(true);
  });

  it('按 action 过滤规则', async () => {
    registry.register(
      makeRule({
        id: 'guard.block.some',
        domain: 'guard',
        action: 'block',
        content: { patterns: ['MUST_NOT_EXIST_XYZ'] },
      }),
    );
    registry.register(
      makeRule({
        id: 'guard.scan.some',
        domain: 'guard',
        action: 'scan',
        content: { patterns: ['ALSO_NOT_EXIST'] },
      }),
    );

    // 只执行 block action
    const report = await engine.evaluateRules({
      repoRoot: tempDir,
      domain: 'guard',
      action: 'block',
    });
    expect(report.total).toBe(1);
    expect(report.evaluations[0].rule.id).toBe('guard.block.some');
  });

  it('多条规则同时评估', async () => {
    const srcDir = path.join(tempDir, 'src');
    mkdirSync(srcDir, { recursive: true });
    // 伪密钥分片拼接，避免源码出现可被 secret 扫描(zhshield generic-api-key)命中的字面量；
    // 写入临时目录的内容仍是完整 sk- 格式，用于验证引擎可检测敏感信息
    const fakeApiKey = ['sk-', 'test12345678901234'].join('');
    writeFileSync(
      path.join(srcDir, 'test.ts'),
      ['const x: string = y as any;', `const apiKey = "${fakeApiKey}";`].join('\n'),
      'utf-8',
    );

    registry.register(
      makeRule({
        id: 'guard.block.sensitive',
        domain: 'guard',
        content: { patterns: ['sk-[a-zA-Z0-9]{16,}'] },
      }),
    );
    registry.register(
      makeRule({
        id: 'inspect.type-safety',
        domain: 'inspect',
        applicableEngines: ['inspect'],
        content: { forbidden: ['as any'] },
      }),
    );

    const report = await engine.evaluateRules({ repoRoot: tempDir });
    expect(report.total).toBe(2);
    // guard 规则应失败（发现 API key）
    const guardEval = report.evaluations.find((e) => e.rule.id === 'guard.block.sensitive');
    expect(guardEval?.status).toBe('failed');
    // inspect 规则应在 domain 未过滤时也被评估
    const inspectEval = report.evaluations.find((e) => e.rule.id === 'inspect.type-safety');
    expect(inspectEval?.status).toBe('failed');
  });

  it('空目录不报错，返回无违规', async () => {
    const emptyDir = path.join(tempDir, 'empty-project');
    mkdirSync(emptyDir, { recursive: true });

    registry.register(
      makeRule({
        id: 'guard.block.sensitive',
        domain: 'guard',
        content: { patterns: ['password\\s*='] },
      }),
    );

    const report = await engine.evaluateRules({ repoRoot: emptyDir, domain: 'guard' });
    expect(report.total).toBe(1);
    expect(report.passed).toBe(1);
  });
});
