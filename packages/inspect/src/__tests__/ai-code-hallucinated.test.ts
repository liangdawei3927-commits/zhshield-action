import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProjectProfile } from '@zh/dependency';
import { HallucinatedDependencyCheckImpl } from '../ai-code/hallucinated-dependency';
import { listNodeModules, packageNameFromSpecifier } from '../ai-code/files';
import { collectNpmPackages, collectPnpmPackages, collectYarnPackages } from '../ai-code/lockfile';

function profile(projectPath: string): ProjectProfile {
  return { projectPath, language: 'typescript', framework: null, packageManager: 'pnpm', hasTypeScript: true };
}

describe('锁文件解析', () => {
  it('pnpm-lock：提取 packages 包名，忽略 overrides', () => {
    const yaml = `
lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      qs:
        specifier: ^6.0.0
        version: 6.15.3

packages:
  /lodash@4.17.21:
    resolution: {integrity: sha512-aaa}
  /@babel/core@7.24.0:
    resolution: {integrity: sha512-bbb}

overrides:
  qs@^6: 6.15.3
`;
    expect([...collectPnpmPackages(yaml)].sort()).toEqual(['@babel/core', 'lodash']);
  });

  it('npm v2/v3：packages 键提取，嵌套路径取最后一段', () => {
    const lock = JSON.stringify({
      name: 'x',
      version: '1.0.0',
      packages: {
        '': { name: 'x' },
        'node_modules/lodash': { version: '4.17.21' },
        'node_modules/@babel/core': { version: '7.24.0' },
        'node_modules/foo/node_modules/bar': { version: '1.0.0' },
      },
    });
    expect([...collectNpmPackages(lock)].sort()).toEqual(['@babel/core', 'bar', 'lodash']);
  });

  it('npm v1：dependencies 键提取', () => {
    const lock = JSON.stringify({
      name: 'x',
      version: '1.0.0',
      dependencies: { lodash: { version: '4.17.21' }, '@babel/core': { version: '7.24.0' } },
    });
    expect([...collectNpmPackages(lock)].sort()).toEqual(['@babel/core', 'lodash']);
  });

  it('yarn v1：头部行提取包名', () => {
    const yarn = `
# yarn lockfile v1

lodash@^4.17.21:
  version "4.17.21"
  resolved "https://registry.yarnpkg.com/lodash/-/lodash-4.17.21.tgz#abc"

"@babel/core@^7.0.0":
  version "7.24.0"
  resolved "https://registry.yarnpkg.com/@babel/core/-/core-7.24.0.tgz#def"
`;
    expect([...collectYarnPackages(yarn)].sort()).toEqual(['@babel/core', 'lodash']);
  });
});

describe('模块说明符解析', () => {
  it('提取包名并排除相对路径/内建', () => {
    expect(packageNameFromSpecifier('@zh/kernel/dist/x')).toBe('@zh/kernel');
    expect(packageNameFromSpecifier('lodash/fp')).toBe('lodash');
    expect(packageNameFromSpecifier('./local')).toBeNull();
    expect(packageNameFromSpecifier('../up')).toBeNull();
    expect(packageNameFromSpecifier('node:fs')).toBeNull();
    expect(packageNameFromSpecifier('fs')).toBeNull();
  });
});

describe('listNodeModules', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zh-ai-nm-'));
    await fs.mkdir(path.join(tmpDir, 'node_modules', 'lodash'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'node_modules', '@scope', 'foo'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'node_modules', '.bin'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('枚举顶层已装包，跳过 .bin 等元数据目录', () => {
    expect([...listNodeModules(tmpDir)].sort()).toEqual(['@scope/foo', 'lodash']);
  });
});

describe('HallucinatedDependencyCheckImpl', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zh-ai-halluc-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeFile(rel: string, content: string): Promise<void> {
    const abs = path.join(tmpDir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }

  it('已声明包跳过；未声明 → not-found；typosquat 命中 → typosquat-similar', async () => {
    await writeFile('package.json', JSON.stringify({ name: 'f', dependencies: { lodash: '^4.17.21' } }));
    await writeFile(
      'pnpm-lock.yaml',
      "lockfileVersion: '9.0'\n\npackages:\n  /lodash@4.17.21:\n    resolution: {integrity: sha512-aaa}\n",
    );
    await fs.mkdir(path.join(tmpDir, 'node_modules', 'lodash'), { recursive: true });
    await writeFile(
      'src/app.ts',
      "import lodash from 'lodash';\nimport 'lodahs';\nimport { ghost } from 'ghost-pkg-xyz';\nimport 'lodahs';\n",
    );

    const findings = await new HallucinatedDependencyCheckImpl().check(profile(tmpDir));

    const lodahs = findings.find((f) => f.packageName === 'lodahs');
    expect(lodahs?.registryStatus).toBe('typosquat-similar');
    expect(lodahs?.referencedFrom.map((r) => r.line).sort()).toEqual([2, 4]);
    expect(lodahs?.evidence.some((e) => e.includes('lodash'))).toBe(true);

    const ghost = findings.find((f) => f.packageName === 'ghost-pkg-xyz');
    expect(ghost?.registryStatus).toBe('not-found');

    expect(findings.some((f) => f.packageName === 'lodash')).toBe(false);
  });

  it('无任何依赖清单 → unverified-offline（不报不存在，边界 3）', async () => {
    await writeFile('src/foo.js', "const x = require('zzz-unknown-pkg-12345');\n");

    const findings = await new HallucinatedDependencyCheckImpl().check(profile(tmpDir));

    expect(findings).toHaveLength(1);
    expect(findings[0]?.registryStatus).toBe('unverified-offline');
    expect(findings[0]?.evidence.join(' ')).toContain('not confirmed');
  });

  it('声明过但未安装 → 非幻觉，不产出', async () => {
    await writeFile('package.json', JSON.stringify({ name: 'f', dependencies: { 'ghost-declared': '^1.0.0' } }));
    await writeFile('src/app.ts', "import 'ghost-declared';\n");

    const findings = await new HallucinatedDependencyCheckImpl().check(profile(tmpDir));
    expect(findings).toHaveLength(0);
  });
});
