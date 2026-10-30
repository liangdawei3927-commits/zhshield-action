import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { SopRuleEngine } from '../runner';
import { SopRegistry } from '../sop/_meta/sop-registry';
import { makeRule } from './helpers/rule-factory';

/**
 * 「不适用」（not-applicable）语义：检测对象在本项目中不存在。
 * 它既不是「通过」（那是「查过且安全」的结论），也不是失败/降级。
 */

describe('SopRuleEngine — security check-list 的不适用语义', () => {
  let registry: SopRegistry;
  let engine: SopRuleEngine;
  let tempDir: string;

  beforeEach(() => {
    registry = new SopRegistry();
    engine = new SopRuleEngine(registry);
    tempDir = mkdtempSync(path.join(tmpdir(), 'rule-engine-applicability-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('security check-list: 全部检测项确知不适用时，规则标为 not-applicable 且不计入通过', async () => {
    // 业务意图：「没得查」不等于「查过且安全」。无 Web 框架的项目没有装配
    // Helmet/CSRF 的位置，若仍算 passed，报告会虚增一条「已验证的安全能力」。
    const mockSecurity = {
      run: async () => ({
        results: [
          {
            status: 'passed',
            applicability: 'not-applicable',
            message: 'helmet-configured: 项目未使用 Web 框架，检查不适用',
          },
          {
            status: 'passed',
            applicability: 'not-applicable',
            message: 'csrf-token-present: 项目未使用 Web 框架，检查不适用',
          },
        ],
      }),
    };

    const engineWithSecurity = new SopRuleEngine(registry, {
      securityCheckEngine: mockSecurity,
    });
    registry.register(
      makeRule({
        id: 'security.web.helmet-check',
        domain: 'security',
        content: {
          checks: [
            { rule: 'helmet-configured', level: 'error' },
            { rule: 'csrf-token-present', level: 'error' },
          ],
        },
      }),
    );

    const report = await engineWithSecurity.evaluateRules({
      repoRoot: tempDir,
      domain: 'security',
    });
    const evalResult = report.evaluations[0];
    expect(evalResult.status).toBe('passed');
    expect(evalResult.applicability).toBe('not-applicable');
    expect(evalResult.message).toContain('未使用 Web 框架');
    // 聚合口径：passed 不包含不适用项，notApplicable 单列
    expect(report.passed).toBe(0);
    expect(report.notApplicable).toBe(1);
    // 不适用不构成失败，也不制造降级护栏
    expect(report.ok).toBe(true);
    expect(report.degraded).toBe(0);
  });

  it('security check-list: 只有一个检测项不适用时，规则仍按普通结果判定', async () => {
    // 混合场景（部分可检）表示规则确实被执行过——不能整条标为不适用。
    const mockSecurity = {
      run: async () => ({
        results: [
          {
            status: 'passed',
            applicability: 'not-applicable',
            message: 'helmet-configured: 项目未使用 Web 框架，检查不适用',
          },
          { status: 'passed', message: 'csrf-token-present: 检测到防护证据' },
        ],
      }),
    };

    const engineWithSecurity = new SopRuleEngine(registry, {
      securityCheckEngine: mockSecurity,
    });
    registry.register(
      makeRule({
        id: 'security.web.mixed-check',
        domain: 'security',
        content: {
          checks: [
            { rule: 'helmet-configured', level: 'error' },
            { rule: 'csrf-token-present', level: 'error' },
          ],
        },
      }),
    );

    const report = await engineWithSecurity.evaluateRules({
      repoRoot: tempDir,
      domain: 'security',
    });
    const evalResult = report.evaluations[0];
    expect(evalResult.status).toBe('passed');
    expect(evalResult.applicability).toBeUndefined();
    expect(report.passed).toBe(1);
    expect(report.notApplicable).toBe(0);
  });
});
