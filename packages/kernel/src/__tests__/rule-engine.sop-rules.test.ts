import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { SopRuleEngine } from '../runner';
import { SopRegistry } from '../sop/_meta/sop-registry';
import { SopLoader } from '../sop/_meta/sop-loader';

/** 真实 SOP 规则目录 */
const SOP_RULES_DIR = path.resolve(__dirname, '../sop');

describe('SOP 规则 — 真实 YAML 文件加载与评估', () => {
  let registry: SopRegistry;
  let engine: SopRuleEngine;
  let tempDir: string;

  beforeEach(async () => {
    registry = new SopRegistry();
    engine = new SopRuleEngine(registry);
    const loader = new SopLoader(registry, { rulesDir: SOP_RULES_DIR });
    await loader.loadFromFileSystem();
    tempDir = mkdtempSync(path.join(tmpdir(), 'sop-rules-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ─── 加载验证 ──────────────────────────────────────────

  it('从文件系统加载 guard 和 security 领域规则', () => {
    const guardRules = registry.getActive().filter((r) => r.domain === 'guard');
    const securityRules = registry.getActive().filter((r) => r.domain === 'security');
    expect(guardRules.length).toBeGreaterThan(0);
    expect(securityRules.length).toBeGreaterThan(0);
  });

  // ─── guard 领域：内联评估（layer-boundary）──────────────

  describe('guard — architecture-boundary（layer-boundary 内联评估）', () => {
    it('正向：infrastructure → presentation 层违规检测', async () => {
      const srcDir = path.join(tempDir, 'src');
      mkdirSync(path.join(srcDir, 'infrastructure'), { recursive: true });
      // architecture-boundary.yml 定义 infrastructure 只能依赖 domain
      writeFileSync(
        path.join(srcDir, 'infrastructure', 'db.ts'),
        'import { UserController } from "presentation/controller";',
        'utf-8',
      );

      const report = await engine.runGuard({ repoRoot: tempDir, dryRun: true });
      const archEval = report.evaluations.find((e) => e.rule.id.includes('architecture-boundary'));
      expect(archEval).toBeDefined();
      expect(archEval!.status).toBe('failed');
      expect(archEval!.violations!.length).toBeGreaterThanOrEqual(1);

      const violation = archEval!.violations![0];
      expect(violation.file).toContain('infrastructure');
      expect(violation.message).toContain('infrastructure');
      expect(violation.message).toContain('presentation');
    });

    it('反向：presentation → application 合规导入', async () => {
      const srcDir = path.join(tempDir, 'src');
      mkdirSync(path.join(srcDir, 'presentation'), { recursive: true });
      // architecture-boundary.yml 定义 presentation 可以依赖 application
      writeFileSync(
        path.join(srcDir, 'presentation', 'controller.ts'),
        'import { UserService } from "application/user-service";',
        'utf-8',
      );

      const report = await engine.runGuard({ repoRoot: tempDir, dryRun: true });
      const archEval = report.evaluations.find((e) => e.rule.id.includes('architecture-boundary'));
      expect(archEval).toBeDefined();
      expect(archEval!.status).toBe('passed');
    });

    it('反向：domain 层无依赖时合规', async () => {
      const srcDir = path.join(tempDir, 'src');
      mkdirSync(path.join(srcDir, 'domain'), { recursive: true });
      // domain 层不允许依赖任何其他层
      writeFileSync(
        path.join(srcDir, 'domain', 'entity.ts'),
        'export class User { id: string; }',
        'utf-8',
      );

      const report = await engine.runGuard({ repoRoot: tempDir, dryRun: true });
      const archEval = report.evaluations.find((e) => e.rule.id.includes('architecture-boundary'));
      expect(archEval).toBeDefined();
      expect(archEval!.status).toBe('passed');
    });
  });

  // ─── guard 领域：阈值规则（非 dryRun 内联评估）──────────

  describe('guard — threshold 规则（非 dryRun）', () => {
    it('test-coverage: 无外部数据时 passed', async () => {
      const report = await engine.runGuard({ repoRoot: tempDir });
      const coverageEval = report.evaluations.find((e) => e.rule.id.includes('test-coverage'));
      expect(coverageEval).toBeDefined();
      expect(coverageEval!.status).toBe('passed');
      expect(coverageEval!.message).toContain('阈值');
    });

    it('health-score: 无外部数据时 passed', async () => {
      const report = await engine.runGuard({ repoRoot: tempDir });
      const healthEval = report.evaluations.find((e) => e.rule.id.includes('health-score'));
      expect(healthEval).toBeDefined();
      expect(healthEval!.status).toBe('passed');
    });
  });

  // ─── guard 领域：外部派发规则（dryRun 跳过）─────────────

  describe('guard — 外部派发规则（dryRun 跳过）', () => {
    it('security-scan: scanner-dispatch 跳过', async () => {
      const report = await engine.runGuard({ repoRoot: tempDir, dryRun: true });
      const evalResult = report.evaluations.find((e) => e.rule.id.includes('security-scan'));
      expect(evalResult).toBeDefined();
      expect(evalResult!.status).toBe('skipped');
    });

    it('eslint-error: preset 跳过', async () => {
      const report = await engine.runGuard({ repoRoot: tempDir, dryRun: true });
      const evalResult = report.evaluations.find((e) => e.rule.id.includes('eslint-error'));
      expect(evalResult).toBeDefined();
      expect(evalResult!.status).toBe('skipped');
    });

    it('typescript-error: check-list 跳过', async () => {
      const report = await engine.runGuard({ repoRoot: tempDir, dryRun: true });
      const evalResult = report.evaluations.find((e) => e.rule.id.includes('typescript-error'));
      expect(evalResult).toBeDefined();
      expect(evalResult!.status).toBe('skipped');
    });
  });

  // ─── security 领域规则 ─────────────────────────────────

  describe('security 领域规则', () => {
    it('加载 security 领域规则并验证数量', () => {
      const securityRules = registry.getActive().filter((r) => r.domain === 'security');
      // vulnerability + malware + garbage 子目录
      expect(securityRules.length).toBeGreaterThanOrEqual(10);
    });

    it('helmet-check: check-list dryRun 跳过', async () => {
      const report = await engine.runInspect({
        repoRoot: tempDir,
        domain: 'security',
        dryRun: true,
      });
      const helmetEval = report.evaluations.find((e) => e.rule.id.includes('helmet-check'));
      expect(helmetEval).toBeDefined();
      expect(helmetEval!.status).toBe('skipped');
    });

    it('csrf-check: check-list dryRun 跳过', async () => {
      const report = await engine.runInspect({
        repoRoot: tempDir,
        domain: 'security',
        dryRun: true,
      });
      const csrfEval = report.evaluations.find((e) => e.rule.id.includes('csrf-check'));
      expect(csrfEval).toBeDefined();
      expect(csrfEval!.status).toBe('skipped');
    });

    it('sql-injection: 重写为 tool-dispatch 后 dryRun 跳过外部派发', async () => {
      const report = await engine.runInspect({
        repoRoot: tempDir,
        domain: 'security',
        dryRun: true,
      });
      const sqliEval = report.evaluations.find((e) => e.rule.id.includes('sql-injection'));
      expect(sqliEval).toBeDefined();
      // tool-dispatch 属于外部派发，dryRun 下跳过（不再静默 passed）
      expect(sqliEval!.status).toBe('skipped');
    });
  });

  // ─── inspect 领域：forbidden 内联评估 ────────────────

  describe('inspect — type-safety（forbidden 内联评估）', () => {
    it('正向：包含 as any 触发违规', async () => {
      const srcDir = path.join(tempDir, 'src');
      mkdirSync(srcDir, { recursive: true });
      // type-safety.yml forbidden 包含 as any / @ts-ignore / @ts-expect-error / any
      writeFileSync(path.join(srcDir, 'service.ts'), 'const user = payload as any;\n', 'utf-8');

      const report = await engine.runInspect({
        repoRoot: tempDir,
        domain: 'inspect',
        dryRun: true,
      });
      const evalResult = report.evaluations.find((e) => e.rule.id.includes('type-safety'));
      expect(evalResult).toBeDefined();
      expect(evalResult!.status).toBe('failed');
      expect(evalResult!.violations!.length).toBeGreaterThanOrEqual(1);
      expect(evalResult!.violations![0].file).toContain('service.ts');
    });

    it('反向：干净文件通过', async () => {
      const srcDir = path.join(tempDir, 'src');
      mkdirSync(srcDir, { recursive: true });
      writeFileSync(path.join(srcDir, 'util.ts'), 'export const id = 42;\n', 'utf-8');

      const report = await engine.runInspect({
        repoRoot: tempDir,
        domain: 'inspect',
        dryRun: true,
      });
      const evalResult = report.evaluations.find((e) => e.rule.id.includes('type-safety'));
      expect(evalResult).toBeDefined();
      expect(evalResult!.status).toBe('passed');
    });
  });

  describe('inspect — module-dependency（forbidden 内联评估）', () => {
    it('正向：core -> ui 依赖方向违规', async () => {
      const srcDir = path.join(tempDir, 'src');
      mkdirSync(srcDir, { recursive: true });
      // module-dependency.yml 禁止 core -> ui / domain -> infrastructure / shared -> feature
      writeFileSync(path.join(srcDir, 'deps.txt'), 'core -> ui\n', 'utf-8');

      const report = await engine.runInspect({
        repoRoot: tempDir,
        domain: 'inspect',
        dryRun: true,
      });
      const evalResult = report.evaluations.find((e) => e.rule.id.includes('module-dependency'));
      expect(evalResult).toBeDefined();
      expect(evalResult!.status).toBe('failed');
      expect(evalResult!.violations!.length).toBeGreaterThanOrEqual(1);
    });

    it('反向：无禁止依赖模式通过', async () => {
      const srcDir = path.join(tempDir, 'src');
      mkdirSync(srcDir, { recursive: true });
      writeFileSync(path.join(srcDir, 'deps.txt'), 'ui -> core\n', 'utf-8');

      const report = await engine.runInspect({
        repoRoot: tempDir,
        domain: 'inspect',
        dryRun: true,
      });
      const evalResult = report.evaluations.find((e) => e.rule.id.includes('module-dependency'));
      expect(evalResult).toBeDefined();
      expect(evalResult!.status).toBe('passed');
    });
  });

  describe('inspect — layer-boundary（layer-boundary 内联评估）', () => {
    it('正向：infrastructure → presentation 层违规', async () => {
      const srcDir = path.join(tempDir, 'src');
      mkdirSync(path.join(srcDir, 'infrastructure'), { recursive: true });
      // layer-boundary.yml: infrastructure 只能依赖 domain
      writeFileSync(
        path.join(srcDir, 'infrastructure', 'db.ts'),
        'import { UserController } from "presentation/controller";\n',
        'utf-8',
      );

      const report = await engine.runInspect({
        repoRoot: tempDir,
        domain: 'inspect',
        dryRun: true,
      });
      const evalResult = report.evaluations.find((e) => e.rule.id.includes('layer-boundary'));
      expect(evalResult).toBeDefined();
      expect(evalResult!.status).toBe('failed');
      expect(evalResult!.violations![0].message).toContain('presentation');
    });

    it('反向：presentation → application 合规导入', async () => {
      const srcDir = path.join(tempDir, 'src');
      mkdirSync(path.join(srcDir, 'presentation'), { recursive: true });
      // presentation 可以依赖 application
      writeFileSync(
        path.join(srcDir, 'presentation', 'controller.ts'),
        'import { UserService } from "application/user-service";\n',
        'utf-8',
      );

      const report = await engine.runInspect({
        repoRoot: tempDir,
        domain: 'inspect',
        dryRun: true,
      });
      const evalResult = report.evaluations.find((e) => e.rule.id.includes('layer-boundary'));
      expect(evalResult).toBeDefined();
      expect(evalResult!.status).toBe('passed');
    });
  });

  // ─── refactor 领域规则：threshold（非 dryRun）─────────

  describe('refactor — threshold 规则（非 dryRun）', () => {
    it('feature-envy: 无外部数据时 passed', async () => {
      const report = await engine.runInspect({ repoRoot: tempDir, domain: 'refactor' });
      const evalResult = report.evaluations.find((e) => e.rule.id.includes('feature-envy'));
      expect(evalResult).toBeDefined();
      expect(evalResult!.status).toBe('passed');
      expect(evalResult!.message).toContain('阈值');
    });
  });

  // ─── 全领域规则清单验证 ──────────────────────────────

  describe('全领域规则加载清单', () => {
    it('加载 guard/inspect/security/sentinel/evolve/refactor 六个领域规则', () => {
      // 仅含真实检测逻辑的规则保持 active；空骨架规则（无 tool/patterns/thresholds
      // 等检测字段）已标记 draft，避免 pattern-scan 兜底造成假通过。
      // guard +2（prettier-check、commit-message），inspect +8（10 条空骨架补实）
      const byDomain = (d: string) => registry.getActive().filter((r) => r.domain === d);
      expect(byDomain('guard').length).toBe(10);
      expect(byDomain('inspect').length).toBe(24);
      expect(byDomain('security').length).toBe(20);
      expect(byDomain('sentinel').length).toBe(0);
      expect(byDomain('evolve').length).toBe(2);
      expect(byDomain('refactor').length).toBe(13);
      expect(registry.getActive().length).toBe(69);
    });
  });
});
