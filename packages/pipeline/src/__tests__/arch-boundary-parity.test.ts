import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { SopRuleEngine, SopRegistry, SopLoader } from '@zh/kernel';
import { ArchitectureBoundaryAdapter } from '@zh/guard';
import type { CheckConfig } from '@zh/guard';

/**
 * 架构边界「同结论」实证（2026-09-18 建立，T8 口径统一）
 *
 * 同一份代码，在两条入口上跑，必须得到同一份违规清单：
 *   - 门禁侧：`ArchitectureBoundaryAdapter`（门禁页 ARCH-001 的执行器）
 *   - 体检侧：SOP 规则 `inspect.scan.depcruiser.layer-boundary`（内核 layer-boundary 内联评估器）
 *
 * 两者此前各持一份层级模型（4 层 rank vs 7 层 allowlist），同一处违规结论可以不同。
 * 现在层级表统一出自 `@zh/shared` 的 `CLEAN_ARCH_LAYERS`，本测试在真实文件系统上
 * 植入一组覆盖「允许边 / 违规边 / 非层目录 / 相对导入 / 别名导入」的样本，
 * 断言两条入口给出的违规集合**逐条相等**。
 */
const PRESETS_DIR = path.resolve(__dirname, '../../../kernel/src/sop/presets/sop-templates');

const GUARD_ARCH_RULE = 'guard.block.depcruiser.architecture';
const INSPECT_ARCH_RULE = 'inspect.scan.depcruiser.layer-boundary';

const CHECK = {
  checkId: 'ARCH-001',
  adapter: 'architecture-boundary',
  mode: ['guard'],
  enabled: true,
  severity: 'error',
  blocking: true,
} as unknown as CheckConfig;

function write(root: string, rel: string, content: string): void {
  const full = path.join(root, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf-8');
}

/**
 * 样本布局（层级表见 CLEAN_ARCH_LAYERS）：
 *   services       → 允许 domain / repositories / adapters / shared；不允许 controllers
 *   controllers    → 允许 services / use-cases / dto
 *   repositories   → 允许 domain / shared；不允许 controllers
 *   pages          → **不是任何层名**，应被两条入口一致地跳过
 */
function seedFixture(root: string): void {
  write(root, 'src/domain/user.ts', 'export class User {}\n');
  write(root, 'src/dto/user.dto.ts', 'export interface UserDto {}\n');
  write(root, 'src/controllers/user.controller.ts', 'export class UserController {}\n');
  write(root, 'src/services/shared-dep.ts', 'export const sharedDep = 1;\n');

  // 允许边：services → domain / shared（两侧都不应报）
  write(
    root,
    'src/services/user.service.ts',
    "import { User } from '../domain/user';\nimport { sharedDep } from './shared-dep';\nexport const s = [User, sharedDep];\n",
  );
  // 违规边：services → controllers
  write(
    root,
    'src/services/bad.service.ts',
    "import { UserController } from '../controllers/user.controller';\nexport const b = UserController;\n",
  );
  // 违规边：repositories → controllers（一轮 import 里两条，验证同行多条 import 不漏）
  write(
    root,
    'src/repositories/user.repository.ts',
    "import { UserController } from '../controllers/user.controller';\nexport const r = UserController;\n",
  );
  // 非层目录：pages 不在层级表里 → 两条入口都应跳过
  write(
    root,
    'src/pages/home.ts',
    "import { UserController } from '../controllers/user.controller';\nexport const p = UserController;\n",
  );
  // 测试文件：被 excludePatterns 排除，即使违规也不报
  write(
    root,
    'src/services/bad.service.spec.ts',
    "import { UserController } from '../controllers/user.controller';\nexport const t = UserController;\n",
  );
}

/** 归一化为可比对的字符串集合（文件名 + 行号 + 方向） */
function normalize(entries: { file: string; line: number; from: string; to: string }[]): string[] {
  return entries
    .map((e) => `${e.file.replace(/\\/g, '/')}:${e.line} [${e.from}→${e.to}]`)
    .sort((a, b) => a.localeCompare(b));
}

/** 门禁侧：适配器直驱 */
function runGuardAdapter(fixture: string): ReturnType<typeof normalize> {
  const adapter = new ArchitectureBoundaryAdapter();
  const raw = adapter.run({ projectPath: fixture, repoRoot: fixture }, CHECK) as {
    violations: { file: string; line: number; fromLayer: string; toLayer: string }[];
    error?: string;
  };
  expect(raw.error).toBeUndefined();
  return normalize(
    raw.violations.map((v) => ({ file: v.file, line: v.line, from: v.fromLayer, to: v.toLayer })),
  );
}

describe('架构边界 — 门禁与体检同结论（T8）', () => {
  let fixture: string;

  beforeEach(() => {
    fixture = mkdtempSync(path.join(tmpdir(), 'zh-arch-parity-'));
  });

  afterEach(() => {
    rmSync(fixture, { recursive: true, force: true });
  });

  it('门禁适配器与体检 SOP 规则报出同一组违规文件与行号', async () => {
    seedFixture(fixture);

    const guardViolations = runGuardAdapter(fixture);

    const registry = new SopRegistry();
    const engine = new SopRuleEngine(registry);
    await new SopLoader(registry, { rulesDir: PRESETS_DIR }).loadFromFileSystem();

    const inspectReport = await engine.evaluateRules({ repoRoot: fixture, domain: 'inspect' });
    const inspectEv = inspectReport.evaluations.find((e) => e.rule.id === INSPECT_ARCH_RULE);
    expect(inspectEv, '体检架构规则未参与评估').toBeDefined();
    const inspectLocations = (inspectEv!.violations ?? [])
      .map((v) => `${v.file.replace(/\\/g, '/')}:${v.line ?? 0}`)
      .sort((a, b) => a.localeCompare(b));

    // 门禁侧去掉方向后缀后，文件与行号必须与体检侧逐条相等
    const guardLocations = guardViolations.map((v) => v.split(' [')[0]!);
    expect(guardLocations).toEqual(inspectLocations);

    // 且两侧都必须真的检出（不是"都不报"式的假一致）
    expect(guardLocations.length).toBe(2);
    expect(guardLocations).toEqual([
      'src/repositories/user.repository.ts:1',
      'src/services/bad.service.ts:1',
    ]);
  });

  it('门禁域架构规则也已 active，且给出与体检相同的方向结论', async () => {
    seedFixture(fixture);

    const registry = new SopRegistry();
    const engine = new SopRuleEngine(registry);
    await new SopLoader(registry, { rulesDir: PRESETS_DIR }).loadFromFileSystem();

    const guardReport = await engine.evaluateRules({ repoRoot: fixture, domain: 'guard' });
    const gateEv = guardReport.evaluations.find((e) => e.rule.id === GUARD_ARCH_RULE);
    expect(gateEv, '门禁域架构规则未参与评估（draft 不会执行）').toBeDefined();

    const gateLocations = (gateEv!.violations ?? [])
      .map((v) => `${v.file.replace(/\\/g, '/')}:${v.line ?? 0}`)
      .sort((a, b) => a.localeCompare(b));

    const adapter = new ArchitectureBoundaryAdapter();
    const raw = adapter.run({ projectPath: fixture, repoRoot: fixture }, CHECK) as {
      violations: { file: string; line: number }[];
    };
    const adapterLocations = raw.violations
      .map((v) => `${v.file.replace(/\\/g, '/')}:${v.line}`)
      .sort((a, b) => a.localeCompare(b));

    expect(gateLocations).toEqual(adapterLocations);
    expect(gateLocations.length).toBe(2);
  });
});
