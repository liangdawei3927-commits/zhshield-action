import { describe, it, expect, afterAll } from 'vitest';
import * as path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { DependencyCruiserAdapter } from '../adapters/dependency-cruiser-adapter';

/**
 * dep-cruiser 适配器 — SOP 规则 ruleDef 合成配置（2026-09-17 建立）
 *
 * 历史缺口：规则 YAML 里声明的 check.rules[].ruleDef 从未被使用 —— 适配器恒以
 * --config 指向项目本地/内核默认配置，架构规范的检查内容实际由配置文件决定，
 * 规则文件形同装饰（circular-dependency 声明 4 条，实际只跑 1 条）。
 *
 * 本测试锁死两件事：
 *   1. 规则声明 ruleDef 时，合成配置真被注入并生效
 *   2. 扫描目标须以相对路径传入，否则规则中的 ^src/... 路径模式静默失配
 *
 * 依赖真实 dep-cruiser 二进制；环境不具备时整体跳过（不产生假红）。
 */
const CLEANUP: string[] = [];

function buildProject(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'zh-depcruise-ruledef-'));
  CLEANUP.push(dir);
  mkdirSync(path.join(dir, 'src/utils'), { recursive: true });
  mkdirSync(path.join(dir, 'src/features/user'), { recursive: true });
  writeFileSync(
    path.join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'commonjs', moduleResolution: 'node' },
      include: ['src'],
    }),
    'utf-8',
  );
  // 层违规：utils 依赖 features（规则 no-utils-to-features 的目标）
  writeFileSync(
    path.join(dir, 'src/utils/helper.ts'),
    `import { UserController } from '../features/user/user.controller';\nexport const helper = (c: UserController) => c;\n`,
    'utf-8',
  );
  writeFileSync(
    path.join(dir, 'src/features/user/user.controller.ts'),
    `export class UserController {}\n`,
    'utf-8',
  );
  // 循环依赖（规则 no-circular 的目标）
  writeFileSync(
    path.join(dir, 'src/circular-a.ts'),
    `import { b } from './circular-b';\nexport const a = () => b();\n`,
    'utf-8',
  );
  writeFileSync(
    path.join(dir, 'src/circular-b.ts'),
    `import { a } from './circular-a';\nexport const b = () => a();\n`,
    'utf-8',
  );
  return dir;
}

const probe = new DependencyCruiserAdapter();
const available = await probe.isAvailable();

describe.skipIf(!available)('dep-cruiser 适配器 — ruleDef 合成配置', () => {
  afterAll(() => {
    for (const dir of CLEANUP) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // 受限环境下清理失败无碍（临时目录由系统回收）
      }
    }
  });

  it('规则声明的 ruleDef 被合成注入并生效（项目无 .dependency-cruiser 配置）', async () => {
    const projectPath = buildProject();
    const adapter = new DependencyCruiserAdapter();
    const rules = [
      {
        id: 'no-utils-to-features',
        description: '工具层不能依赖业务层',
        severity: 'error',
        ruleDef: { from: { path: '^src/utils' }, to: { path: '^src/features' } },
      },
      { id: 'no-circular', severity: 'error', ruleDef: { from: {}, to: { circular: true } } },
    ];

    const result = await adapter.scan({
      projectPath,
      projectId: projectPath,
      targetFiles: [],
      config: { enabled: true, rules } as never,
    });

    expect(result.status).toBe('available');
    const ruleIds = new Set(result.issues.map((i) => i.ruleId));
    // 路径相关规则必须报出：验证「相对路径扫描目标」这一前提（绝对路径下静默失配）
    expect(ruleIds.has('no-utils-to-features')).toBe(true);
    expect(ruleIds.has('no-circular')).toBe(true);
  }, 240000);

  it('未声明 ruleDef 时回退基线配置，不注入规则', async () => {
    const projectPath = buildProject();
    const adapter = new DependencyCruiserAdapter();

    const result = await adapter.scan({
      projectPath,
      projectId: projectPath,
      targetFiles: [],
      config: { enabled: true } as never,
    });

    expect(result.status).toBe('available');
    const ruleIds = new Set(result.issues.map((i) => i.ruleId));
    // 基线配置只含 no-circular；no-utils-to-features 属规则注入，不应出现
    expect(ruleIds.has('no-utils-to-features')).toBe(false);
  }, 240000);
});
