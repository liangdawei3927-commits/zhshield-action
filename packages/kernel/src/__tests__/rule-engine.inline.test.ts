import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { SopRuleEngine } from '../runner';
import { SopRegistry } from '../sop/_meta/sop-registry';
import { makeRule } from './helpers/rule-factory';

describe('SopRuleEngine — 内联评估（pattern-scan / forbidden / threshold / layer-boundary）', () => {
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

  it('pattern-scan: 正则匹配敏感信息', async () => {
    const srcDir = path.join(tempDir, 'src');
    mkdirSync(srcDir, { recursive: true });
    // 伪密钥分片拼接，避免源码出现可被 secret 扫描(zhshield generic-api-key)命中的字面量；
    // 写入临时目录的内容仍是完整 sk- 格式，用于验证引擎可检测敏感信息
    const fakeApiKey = ['sk-', 'abc123def456ghi789'].join('');
    writeFileSync(path.join(srcDir, 'config.ts'), [
      `const API_KEY = "${fakeApiKey}";`,
      'const password = "super-secret-123";',
      'const normal = "hello-world";',
    ].join('\n'), 'utf-8');

    registry.register(makeRule({
      id: 'guard.block.sensitive-info',
      domain: 'guard',
      action: 'block',
      severity: 'critical',
      applicableEngines: ['guard'],
      content: {
        patterns: [
          'sk-[a-zA-Z0-9]{16,}',
          'password\\s*[:=]\\s*["\']',
        ],
      },
    }));

    const report = await engine.evaluateRules({ repoRoot: tempDir, domain: 'guard' });
    expect(report.total).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.evaluations[0].status).toBe('failed');
    expect(report.evaluations[0].violations!.length).toBeGreaterThanOrEqual(2);

    // 验证具体违规
    const violations = report.evaluations[0].violations!;
    const apiKeyViolation = violations.find((v) => v.message.includes('sk-'));
    const pwdViolation = violations.find((v) => v.message.includes('password'));
    expect(apiKeyViolation).toBeDefined();
    expect(pwdViolation).toBeDefined();
    expect(apiKeyViolation!.severity).toBe('critical');
  });

  it('pattern-scan: 无违规时 passed', async () => {
    const srcDir = path.join(tempDir, 'src');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(path.join(srcDir, 'safe.ts'), [
      'const greeting = "hello";',
      'const count = 42;',
    ].join('\n'), 'utf-8');

    registry.register(makeRule({
      id: 'guard.pattern.safe',
      domain: 'guard',
      content: { patterns: ['(password|secret|token)\\s*='] },
    }));

    const report = await engine.evaluateRules({ repoRoot: tempDir });
    expect(report.total).toBe(1);
    expect(report.passed).toBe(1);
    expect(report.ok).toBe(true);
  });

  it('pattern-scan: 非 src 布局（packages/）仍能命中', async () => {
    // 无 src/ 目录，源码放在 packages/ 下，验证候选源码根回退
    const pkgDir = path.join(tempDir, 'packages', 'core');
    mkdirSync(pkgDir, { recursive: true });
    const fakeApiKey = ['sk-', 'fedcba9876543210'].join('');
    writeFileSync(path.join(pkgDir, 'config.ts'), [
      `const API_KEY = "${fakeApiKey}";`,
    ].join('\n'), 'utf-8');

    registry.register(makeRule({
      id: 'guard.block.sensitive-pkg',
      domain: 'guard',
      action: 'block',
      severity: 'critical',
      applicableEngines: ['guard'],
      content: { patterns: ['sk-[a-zA-Z0-9]{16,}'] },
    }));

    const report = await engine.evaluateRules({ repoRoot: tempDir, domain: 'guard' });
    expect(report.total).toBe(1);
    expect(report.failed).toBe(1);
    const violations = report.evaluations[0].violations!;
    expect(violations.some((v) => v.message.includes('sk-'))).toBe(true);
    expect(violations.some((v) => v.file.includes('packages'))).toBe(true);
  });

  it('forbidden: 检测 as any / ts-ignore', async () => {
    const srcDir = path.join(tempDir, 'src');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(path.join(srcDir, 'unsafe.ts'), [
      'const x: any = 42;  // as any used here',
      '// @ts-ignore',
      'const y: string = x as any;',
    ].join('\n'), 'utf-8');

    registry.register(makeRule({
      id: 'inspect.typescript.type-safety',
      domain: 'inspect',
      action: 'scan',
      severity: 'error',
      applicableEngines: ['inspect'],
      content: { forbidden: ['as any', '@ts-ignore'] },
    }));

    const report = await engine.evaluateRules({
      repoRoot: tempDir,
      domain: 'inspect',
    });
    expect(report.total).toBe(1);
    expect(report.failed).toBe(1);

    const violations = report.evaluations[0].violations!;
    expect(violations.some((v) => v.message.includes('as any'))).toBe(true);
    expect(violations.some((v) => v.message.includes('@ts-ignore'))).toBe(true);
  });

  it('threshold: 无外部数据时返回 passed + 提示信息', async () => {
    registry.register(makeRule({
      id: 'guard.block.test-coverage',
      domain: 'guard',
      content: { threshold: 80, unit: 'percent', scope: 'diff' },
    }));

    const report = await engine.evaluateRules({ repoRoot: tempDir });
    expect(report.total).toBe(1);
    expect(report.passed).toBe(1);
    expect(report.evaluations[0].message).toContain('阈值');
  });

  it('layer-boundary: 检测层违规导入', async () => {
    const srcDir = path.join(tempDir, 'src');
    // 模拟三层架构
    mkdirSync(path.join(srcDir, 'presentation'), { recursive: true });
    mkdirSync(path.join(srcDir, 'domain'), { recursive: true });
    mkdirSync(path.join(srcDir, 'infrastructure'), { recursive: true });

    // presentation → domain 是合规的
    writeFileSync(path.join(srcDir, 'presentation', 'controller.ts'), [
      'import { UserService } from "domain/user-service";',
    ].join('\n'), 'utf-8');

    // infrastructure → presentation 是违规的（infra 只能依赖 domain）
    writeFileSync(path.join(srcDir, 'infrastructure', 'db.ts'), [
      'import { UserController } from "presentation/controller";',
    ].join('\n'), 'utf-8');

    registry.register(makeRule({
      id: 'guard.block.architecture-boundary',
      domain: 'guard',
      action: 'block',
      severity: 'error',
      applicableEngines: ['guard'],
      content: {
        layers: [
          { name: 'presentation', allowedDependencies: ['domain'] },
          { name: 'domain', allowedDependencies: [] },
          { name: 'infrastructure', allowedDependencies: ['domain'] },
        ],
      },
    }));

    const report = await engine.evaluateRules({ repoRoot: tempDir, domain: 'guard' });
    expect(report.total).toBe(1);
    expect(report.failed).toBe(1);

    const violations = report.evaluations[0].violations!;
    const infraViolation = violations.find((v) => v.file.includes('infrastructure'));
    expect(infraViolation).toBeDefined();
    expect(infraViolation!.message).toContain('infrastructure');
    expect(infraViolation!.message).toContain('presentation');
  });
});
