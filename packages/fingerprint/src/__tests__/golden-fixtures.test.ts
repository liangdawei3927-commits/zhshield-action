// golden fixture 联动测试：把 fixtures/golden/ts-monorepo 的 golden.json 期望
// （packages/core = React workspace）接到探测器自动化断言上（只读仓库 fixture，不写盘）。

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ManifestDetector } from '../detectors/manifest-detector';
import { ConfigDetector } from '../detectors/config-detector';

const TS_MONOREPO_DIR = path.resolve(__dirname, '../../fixtures/golden/ts-monorepo');

describe('golden fixtures（ts-monorepo）', () => {
  it('GIVEN fixtures/golden/ts-monorepo 存在 WHEN 前置校验 THEN fixture 树完整（根清单 + workspaces + 嵌套 core 清单）', () => {
    expect(fs.existsSync(path.join(TS_MONOREPO_DIR, 'package.json'))).toBe(true);
    expect(fs.existsSync(path.join(TS_MONOREPO_DIR, 'packages', 'core', 'package.json'))).toBe(
      true,
    );
    const rootPkg: unknown = JSON.parse(
      fs.readFileSync(path.join(TS_MONOREPO_DIR, 'package.json'), 'utf-8'),
    );
    expect(rootPkg).toEqual(expect.objectContaining({ workspaces: ['packages/*'] }));
  });

  it('GIVEN npm/yarn 风格 workspaces WHEN ManifestDetector.detect THEN packages/core/package.json 被发现且产出 React 框架信号（golden.json 期望）', async () => {
    const signals = await new ManifestDetector().detect(TS_MONOREPO_DIR);

    const coreManifest = signals.find(
      (s) => s.ruleId === 'manifest:package-json' && s.file === 'packages/core/package.json',
    );
    expect(coreManifest).toBeDefined();

    const react = signals.find(
      (s) => s.ruleId === 'manifest:framework:react' && s.file === 'packages/core/package.json',
    );
    expect(react).toBeDefined();

    const next = signals.find(
      (s) => s.ruleId === 'manifest:framework:next-js' && s.file === 'package.json',
    );
    expect(next).toBeDefined();
  });

  it('GIVEN 根 tsconfig.json WHEN ConfigDetector.detect THEN config:tsconfig 信号指向根配置', async () => {
    const signals = await new ConfigDetector().detect(TS_MONOREPO_DIR);
    const tsconfig = signals.find((s) => s.ruleId === 'config:tsconfig');
    expect(tsconfig?.file).toBe('tsconfig.json');
  });
});
