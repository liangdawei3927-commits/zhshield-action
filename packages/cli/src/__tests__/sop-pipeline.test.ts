import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { PipelineRunner } from '@zh/pipeline';
import { augmentProcessPath } from '@zh/shared';

// packages/cli/src/__tests__ → 4 级上溯 = 仓库根
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const SAMPLE_REPO = path.join(REPO_ROOT, 'scripts', 'fixtures', 'sample-repo');
const SOP_TEMPLATES = path.join(
  REPO_ROOT,
  'packages',
  'kernel',
  'src',
  'sop',
  'presets',
  'sop-templates',
);

// 镜像 CLI 启动行为（index.ts:236 在模块加载时调用）：补齐 nvm/Homebrew/~/.local/bin
// 等目录到 PATH。skipIf 条件在收集期求值（早于 beforeAll），故此处先调用一次，
// beforeAll 中的调用为幂等 no-op，保证规则加载前 PATH 已就绪。
augmentProcessPath();

const GITLEAKS_RULE_ID = 'security.scan.gitleaks.hardcoded-key';
const ESLINT_RULE_ID = 'guard.block.external.eslint-error';

function isGitleaksAvailable(): boolean {
  try {
    execSync('which gitleaks', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('CLI SOP 流水线 — 规则加载与已知问题检测（回归门禁）', () => {
  let runner: PipelineRunner;
  let projectDir: string;
  let ruleCount: number;

  beforeAll(async () => {
    // 镜像 CLI 启动行为：补齐外部工具搜索路径（幂等，模块级已调用一次）
    augmentProcessPath();
    // 在临时目录复制固定样本：外部工具（semgrep 等）扫描时会向目标写入
    // .semgrep/inline-*.yml 等产物，直接扫固定样本会污染被门禁守护的 fixture。
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhshield-sop-'));
    fs.cpSync(SAMPLE_REPO, projectDir, { recursive: true });

    runner = new PipelineRunner(projectDir, { configDir: SOP_TEMPLATES });
    ruleCount = await runner.loadSopRules();
  });

  afterAll(async () => {
    await runner.destroy();
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('Given 固定样本项目，When 加载 SOP 规则，Then 规则数 > 0', () => {
    expect(ruleCount).toBeGreaterThan(0);
  });

  it.skipIf(!isGitleaksAvailable())('Given 植入硬编码密钥的样本项目，When SOP Inspect 巡检，Then gitleaks 规则失败并报告违规', async () => {
    const report = await runner.runSopInspect({ domains: ['security'] });

    const gitleaksEval = report.evaluations.find((ev) => ev.rule.id === GITLEAKS_RULE_ID);
    expect(gitleaksEval).toBeDefined();
    expect(gitleaksEval!.status).toBe('failed');

    const violations = gitleaksEval!.violations ?? [];
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.file.includes('credentials.ts'))).toBe(true);
    // security 域为全量扫描（含 semgrep 对 fixutre 全量分析 ~60s），
    // 门禁同时覆盖 gitleaks 检出 + 全量扫描不崩溃，阈值放宽到 120s
  }, 120_000);

  it('Given 植入未使用变量的样本项目与 ESLint flat config，When SOP Guard 门禁，Then eslint-error 规则失败并报告违规', async () => {
    // 不传 domains，跑全 guard 域（guard 域含 eslint-error 规则）。
    // 显式注入 typescript 画像：fixture 无 tsconfig/依赖，自动画像为 unknown，
    // 会触发 M4 工具 scope 裁剪把 eslint 裁掉（与本次回归的配置回退链无关）。
    const report = await runner.runSopGuard({
      projectFeature: { language: 'typescript', features: ['typescript'] },
    });

    const eslintEval = report.evaluations.find((ev) => ev.rule.id === ESLINT_RULE_ID);
    expect(eslintEval).toBeDefined();
    expect(eslintEval!.status).toBe('failed');

    const violations = eslintEval!.violations ?? [];
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.file.includes('eslint-unused.js'))).toBe(true);
  }, 120_000);
});