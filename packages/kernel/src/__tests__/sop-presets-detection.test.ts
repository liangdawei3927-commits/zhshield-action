import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { SopRuleEngine } from '../runner';
import { SopRegistry } from '../sop/_meta/sop-registry';
import { SopLoader } from '../sop/_meta/sop-loader';

/**
 * T4 检出能力回归（2026-09-18）
 *
 * 背景：inspect 域原有 7 条规则用**不存在的伪 tool** 声明（custom-ast-scanner /
 * tsc-config-validator / 结构不被识别的 dep-cruiser），status=draft 从未执行。
 * T4 把它们改写为内核可解释形式并转 active。
 *
 * 「转 active」本身不等于「能检出」—— 本文件在真实文件系统上植入对应的违规样本，
 * 断言每条规则确实产出违规。任何一条检不出，说明只是换了种方式空跑，必须红。
 */
const PRESETS_DIR = path.resolve(__dirname, '../sop/presets/sop-templates');

function write(root: string, rel: string, content: string): void {
  const full = path.join(root, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf-8');
}

describe('T4 — 原 7 条 draft 规则的检出能力', () => {
  let registry: SopRegistry;
  let engine: SopRuleEngine;
  let fixture: string;

  beforeEach(async () => {
    registry = new SopRegistry();
    engine = new SopRuleEngine(registry);
    await new SopLoader(registry, { rulesDir: PRESETS_DIR }).loadFromFileSystem();
    fixture = mkdtempSync(path.join(tmpdir(), 'zh-t4-detect-'));
  });

  afterEach(() => {
    rmSync(fixture, { recursive: true, force: true });
  });

  async function evalRule(id: string) {
    const report = await engine.evaluateRules({ repoRoot: fixture, domain: 'inspect' });
    return report.evaluations.find((e) => e.rule.id === id);
  }

  it('layer-boundary：repositories → controllers 的层违规被检出', async () => {
    // repositories 层只允许依赖 domain / shared
    write(
      fixture,
      'src/repositories/user.repository.ts',
      "import { UserController } from '../controllers/user.controller';\nexport const r = UserController;\n",
    );
    write(fixture, 'src/controllers/user.controller.ts', 'export class UserController {}\n');

    const ev = await evalRule('inspect.scan.depcruiser.layer-boundary');
    expect(ev).toBeDefined();
    expect(ev!.status).toBe('failed');
    expect(ev!.violations!.some((v) => v.message.includes('repositories'))).toBe(true);
    expect(ev!.violations!.some((v) => v.message.includes('controllers'))).toBe(true);
  });

  it('layer-boundary：合规依赖不产生违规（反向）', async () => {
    // repositories → domain 是允许的
    write(
      fixture,
      'src/repositories/user.repository.ts',
      "import { User } from '../domain/user';\nexport const r = User;\n",
    );
    write(fixture, 'src/domain/user.ts', 'export class User {}\n');

    const ev = await evalRule('inspect.scan.depcruiser.layer-boundary');
    expect(ev!.status).toBe('passed');
  });

  it('dependency-injection：forwardRef 与直接实例化外部库被检出', async () => {
    write(
      fixture,
      'src/services/legacy.service.ts',
      [
        "import { forwardRef } from '@nestjs/common';",
        'export class LegacyService {',
        '  private readonly client = new PrismaClient();',
        '}',
        'export const m = forwardRef(() => LegacyService);',
      ].join('\n'),
    );

    const ev = await evalRule('inspect.scan.ironnest.dependency-injection');
    expect(ev!.status).toBe('failed');
    const msgs = ev!.violations!.map((v) => v.message).join(' | ');
    expect(msgs).toContain('forwardRef');
    expect(msgs).toContain('外部库');
  });

  it('enum-usage：const enum 被检出', async () => {
    write(fixture, 'src/enums/status.ts', "export const enum Status {\n  Active = 'active',\n}\n");

    const ev = await evalRule('inspect.scan.internal.enum-usage');
    expect(ev!.status).toBe('failed');
    expect(ev!.violations!.some((v) => v.message.includes('const enum'))).toBe(true);
  });

  it('null-safety：非空断言与 definite assignment 断言被检出', async () => {
    write(
      fixture,
      'src/services/user.service.ts',
      [
        'export class UserService {',
        '  private name!: string;',
        '  run(user: { name: string } | null) {',
        '    return user!.name;',
        '  }',
        '}',
      ].join('\n'),
    );

    const ev = await evalRule('inspect.scan.internal.null-safety');
    expect(ev!.status).toBe('failed');
    const msgs = ev!.violations!.map((v) => v.message).join(' | ');
    expect(msgs).toContain('非空断言');
    expect(msgs).toContain('definite assignment');
  });

  it('null-safety：!== 与逻辑非不误报（反向）', async () => {
    write(
      fixture,
      'src/services/ok.service.ts',
      [
        'export function check(a: number | null, b: number) {',
        '  if (a !== null && a !== b) return true;',
        '  const flag = !a;',
        '  return flag;',
        '}',
      ].join('\n'),
    );

    const ev = await evalRule('inspect.scan.internal.null-safety');
    expect(ev!.status).toBe('passed');
  });

  it('strict-mode：tsconfig.json 缺严格标志被检出', async () => {
    write(
      fixture,
      'tsconfig.json',
      JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'commonjs' } }, null, 2),
    );

    const ev = await evalRule('inspect.scan.internal.strict-mode');
    expect(ev!.status).toBe('failed');
    const msgs = ev!.violations!.map((v) => v.message).join(' | ');
    expect(msgs).toContain('compilerOptions.strict');
    expect(msgs).toContain('noUncheckedIndexedAccess');
  });

  it('strict-mode：标志齐备时通过（反向）', async () => {
    write(
      fixture,
      'tsconfig.json',
      JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noUncheckedIndexedAccess: true,
            exactOptionalPropertyTypes: true,
          },
        },
        null,
        2,
      ),
    );

    const ev = await evalRule('inspect.scan.internal.strict-mode');
    expect(ev!.status).toBe('passed');
  });

  it('type-safety：: any / <any> / any[] 被检出', async () => {
    write(
      fixture,
      'src/types/loose.ts',
      [
        'export const payload: any = {};',
        'export function pick<T>(items: Array<any>): any {',
        '  return items;',
        '}',
      ].join('\n'),
    );

    const ev = await evalRule('inspect.scan.internal.type-safety');
    expect(ev!.status).toBe('failed');
    expect(ev!.violations!.length).toBeGreaterThanOrEqual(2);
  });

  it('type-safety：as any 不归本条（与 type-consistency 切分，反向）', async () => {
    write(fixture, 'src/types/cast.ts', 'export const v = JSON.parse("{}") as any;\n');

    const ev = await evalRule('inspect.scan.internal.type-safety');
    expect(ev!.status).toBe('passed');
  });
});
