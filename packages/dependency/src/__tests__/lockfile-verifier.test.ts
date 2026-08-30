import { describe, expect, it, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LockfileVerifierImpl, lockfileVerifier } from '../adapters/lockfile-verifier';

/** 创建临时目录并登记清理 */
const dirs: string[] = [];
function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function writeFile(dir: string, name: string, content: string): string {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

afterEach(() => {
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
});

describe('LockfileVerifierImpl npm', () => {
  it('声明范围全部满足且完整性字段齐全 → status clean + 空 diffs', async () => {
    const dir = tmpDir('zh-lock-clean-');
    writeFile(dir, 'package.json', JSON.stringify({
      name: 'app',
      dependencies: { react: '^18.2.0', lodash: '^4.17.21' },
      devDependencies: { typescript: '^5.7.0' },
    }));
    writeFile(dir, 'package-lock.json', JSON.stringify({
      name: 'app',
      lockfileVersion: 3,
      packages: {
        '': { name: 'app' },
        'node_modules/react': { version: '18.2.0', integrity: 'sha512-react-hash' },
        'node_modules/lodash': { version: '4.17.21', integrity: 'sha512-lodash-hash' },
        'node_modules/typescript': { version: '5.7.2', integrity: 'sha512-ts-hash' },
      },
    }));

    const verifier = new LockfileVerifierImpl();
    const result = await verifier.verify(dir);

    expect(result.status).toBe('clean');
    expect(result.lockfilePath).toBe(path.join(dir, 'package-lock.json'));
    expect(result.diffs).toEqual([]);
    expect(result.integrityFailures).toEqual([]);
  });

  it('锁定版本违反声明范围 → status modified + 正确 diff 条目', async () => {
    const dir = tmpDir('zh-lock-tampered-');
    writeFile(dir, 'package.json', JSON.stringify({
      name: 'app',
      dependencies: { lodash: '^4.17.21', react: '^18.2.0' },
    }));
    // lodash 被篡改为 5.0.0（超出 ^4.17.21 上界）
    writeFile(dir, 'package-lock.json', JSON.stringify({
      name: 'app',
      lockfileVersion: 3,
      packages: {
        'node_modules/lodash': { version: '5.0.0', integrity: 'sha512-lodash-tampered' },
        'node_modules/react': { version: '18.2.0', integrity: 'sha512-react-hash' },
      },
    }));

    const result = await lockfileVerifier.verify(dir);

    expect(result.status).toBe('modified');
    expect(result.diffs).toEqual([
      { name: 'lodash', declaredVersion: '^4.17.21', lockedVersion: '5.0.0' },
    ]);
    expect(result.integrityFailures).toEqual([]);
  });

  it('清单声明的依赖未出现在锁文件中 → diff 且 lockedVersion 为空串', async () => {
    const dir = tmpDir('zh-lock-missing-dep-');
    writeFile(dir, 'package.json', JSON.stringify({ dependencies: { ghost: '^1.0.0' } }));
    writeFile(dir, 'package-lock.json', JSON.stringify({
      lockfileVersion: 3,
      packages: { 'node_modules/other': { version: '2.0.0', integrity: 'sha512-other-hash' } },
    }));

    const result = await lockfileVerifier.verify(dir);
    expect(result.status).toBe('modified');
    expect(result.diffs).toEqual([{ name: 'ghost', declaredVersion: '^1.0.0', lockedVersion: '' }]);
  });

  it('锁文件条目缺少 integrity → integrityFailures 记录且 status modified', async () => {
    const dir = tmpDir('zh-lock-no-integrity-');
    writeFile(dir, 'package.json', JSON.stringify({ dependencies: { lodash: '^4.17.21' } }));
    writeFile(dir, 'package-lock.json', JSON.stringify({
      lockfileVersion: 3,
      packages: {
        'node_modules/lodash': { version: '4.17.21' }, // 无 integrity
      },
    }));

    const result = await lockfileVerifier.verify(dir);

    expect(result.status).toBe('modified');
    expect(result.integrityFailures).toEqual(['[npm] lodash@4.17.21 缺少 integrity 完整性字段']);
  });

  it('expectedIntegrity 基线不一致 → 校验和不匹配', async () => {
    const dir = tmpDir('zh-lock-hash-mismatch-');
    writeFile(dir, 'package.json', JSON.stringify({ dependencies: { lodash: '^4.17.21' } }));
    writeFile(dir, 'package-lock.json', JSON.stringify({
      lockfileVersion: 3,
      packages: {
        'node_modules/lodash': { version: '4.17.21', integrity: 'sha512-actual-hash' },
      },
    }));

    const result = await lockfileVerifier.verify(dir, {
      expectedIntegrity: { 'lodash@4.17.21': 'sha512-expected-hash' },
    });

    expect(result.status).toBe('modified');
    expect(result.integrityFailures).toEqual([
      '[npm] lodash@4.17.21 校验和不匹配：期望 sha512-expected-hash，实际 sha512-actual-hash',
    ]);
  });

  it('锁文件 JSON 损坏 → 不抛异常，status modified', async () => {
    const dir = tmpDir('zh-lock-corrupt-');
    writeFile(dir, 'package.json', JSON.stringify({ dependencies: { lodash: '^4.17.21' } }));
    writeFile(dir, 'package-lock.json', '{not json');

    await expect(lockfileVerifier.verify(dir)).resolves.toMatchObject({
      status: 'modified',
      diffs: [{ name: 'lodash', declaredVersion: '^4.17.21', lockedVersion: '' }],
    });
    const result = await lockfileVerifier.verify(dir);
    expect(result.integrityFailures.length).toBeGreaterThan(0);
  });
});

describe('LockfileVerifierImpl 缺失场景', () => {
  it('只有 package.json 无锁文件 → status missing', async () => {
    const dir = tmpDir('zh-lock-missing-');
    writeFile(dir, 'package.json', JSON.stringify({ dependencies: { lodash: '^4.17.21' } }));

    const result = await lockfileVerifier.verify(dir);

    expect(result.status).toBe('missing');
    expect(result.lockfilePath).toBeUndefined();
    expect(result.diffs).toEqual([]);
    expect(result.integrityFailures).toEqual([]);
  });

  it('空目录（无清单无锁文件）→ status missing', async () => {
    const dir = tmpDir('zh-lock-empty-');

    const result = await lockfileVerifier.verify(dir);

    expect(result.status).toBe('missing');
  });

  it('pnpm-lock.yaml 满足声明 → status clean', async () => {
    const dir = tmpDir('zh-lock-pnpm-');
    writeFile(dir, 'package.json', JSON.stringify({ dependencies: { lodash: '^4.17.21' } }));
    writeFile(dir, 'pnpm-lock.yaml', [
      "lockfileVersion: '9.0'",
      'importers:',
      '  .:',
      '    dependencies:',
      '      lodash:',
      '        specifier: ^4.17.21',
      '        version: 4.17.21',
      'packages:',
      '  /lodash@4.17.21:',
      '    resolution: {integrity: sha512-pnpm-lodash}',
    ].join('\n'));

    const result = await lockfileVerifier.verify(dir);

    expect(result.status).toBe('clean');
    expect(result.diffs).toEqual([]);
  });

  it('pnpm 本地 workspace 包（file:/link:、resolution.type=directory）无 integrity → 不误报，status clean', async () => {
    const dir = tmpDir('zh-lock-pnpm-workspace-');
    writeFile(dir, 'package.json', JSON.stringify({ dependencies: { lodash: '^4.17.21' } }));
    writeFile(dir, 'pnpm-lock.yaml', [
      "lockfileVersion: '9.0'",
      'importers:',
      '  .:',
      '    dependencies:',
      '      lodash:',
      '        specifier: ^4.17.21',
      '        version: 4.17.21',
      "      '@zh/db':",
      '        specifier: file:packages/db',
      '        version: file:packages/db',
      'packages:',
      '  /lodash@4.17.21:',
      '    resolution: {integrity: sha512-pnpm-lodash}',
      "  '@zh/db@file:packages/db':",
      '    resolution: {directory: packages/db, type: directory}',
    ].join('\n'));

    const result = await lockfileVerifier.verify(dir);

    expect(result.status).toBe('clean');
    expect(result.integrityFailures).toEqual([]);
  });

  it('pnpm 注册表包缺少 integrity → 仍正常报缺失（不受本地包豁免影响）', async () => {
    const dir = tmpDir('zh-lock-pnpm-registry-missing-');
    writeFile(dir, 'package.json', JSON.stringify({ dependencies: { lodash: '^4.17.21' } }));
    writeFile(dir, 'pnpm-lock.yaml', [
      "lockfileVersion: '9.0'",
      'importers:',
      '  .:',
      '    dependencies:',
      '      lodash:',
      '        specifier: ^4.17.21',
      '        version: 4.17.21',
      'packages:',
      '  /lodash@4.17.21:',
      '    resolution: {integrity: ""}',
    ].join('\n'));

    const result = await lockfileVerifier.verify(dir);

    expect(result.status).toBe('modified');
    expect(result.integrityFailures).toContain('[pnpm] lodash@4.17.21 缺少 resolution.integrity 完整性字段');
  });
});

describe('LockfileVerifierImpl 基线比对（expectedIntegrity）', () => {
  const lockfile = {
    name: 'app',
    lockfileVersion: 3,
    packages: {
      '': { name: 'app' },
      'node_modules/lodash': { version: '4.17.21', integrity: 'sha512-lodash-hash' },
      'node_modules/react': { version: '18.2.0', integrity: 'sha512-react-hash' },
    },
  };

  it('基线哈希与锁文件一致 → integrityFailures 空、status clean', async () => {
    const dir = tmpDir('zh-lock-baseline-ok-');
    writeFile(dir, 'package.json', JSON.stringify({ dependencies: { lodash: '^4.17.21', react: '^18.2.0' } }));
    writeFile(dir, 'package-lock.json', JSON.stringify(lockfile));

    const result = await lockfileVerifier.verify(dir, {
      expectedIntegrity: {
        'lodash@4.17.21': 'sha512-lodash-hash',
        'react@18.2.0': 'sha512-react-hash',
      },
    });

    expect(result.status).toBe('clean');
    expect(result.integrityFailures).toEqual([]);
  });

  it('同版本哈希被篡改 → mismatch 命中，消息含「校验和不匹配」', async () => {
    const dir = tmpDir('zh-lock-baseline-mismatch-');
    writeFile(dir, 'package.json', JSON.stringify({ dependencies: { lodash: '^4.17.21', react: '^18.2.0' } }));
    writeFile(dir, 'package-lock.json', JSON.stringify(lockfile));

    const result = await lockfileVerifier.verify(dir, {
      expectedIntegrity: {
        // 基线里 lodash 的哈希被改（同版本，模拟篡改）
        'lodash@4.17.21': 'sha512-original-hash',
        'react@18.2.0': 'sha512-react-hash',
      },
    });

    expect(result.status).toBe('modified');
    expect(result.integrityFailures).toEqual([
      '[npm] lodash@4.17.21 校验和不匹配：期望 sha512-original-hash，实际 sha512-lodash-hash',
    ]);
  });

  it('升级版本（旧基线条目丢失）→ 不误报', async () => {
    const dir = tmpDir('zh-lock-baseline-upgrade-');
    writeFile(dir, 'package.json', JSON.stringify({ dependencies: { lodash: '^4.17.21' } }));
    writeFile(dir, 'package-lock.json', JSON.stringify({
      name: 'app',
      lockfileVersion: 3,
      packages: { 'node_modules/lodash': { version: '4.18.0', integrity: 'sha512-lodash-new' } },
    }));

    const result = await lockfileVerifier.verify(dir, {
      expectedIntegrity: { 'lodash@4.17.21': 'sha512-lodash-old' },
    });

    // actual === undefined（当前节点是 4.18.0，基线条目是 4.17.21）→ 跳过，不报
    expect(result.status).toBe('clean');
    expect(result.integrityFailures).toEqual([]);
  });

  it('基线含不在锁文件中的条目 → 不报（忽略幽灵条目）', async () => {
    const dir = tmpDir('zh-lock-baseline-ghost-');
    writeFile(dir, 'package.json', JSON.stringify({ dependencies: { lodash: '^4.17.21' } }));
    writeFile(dir, 'package-lock.json', JSON.stringify({
      name: 'app',
      lockfileVersion: 3,
      packages: { 'node_modules/lodash': { version: '4.17.21', integrity: 'sha512-lodash-hash' } },
    }));

    const result = await lockfileVerifier.verify(dir, {
      expectedIntegrity: {
        'lodash@4.17.21': 'sha512-lodash-hash',
        'ghost@1.0.0': 'sha512-ghost',
      },
    });

    expect(result.status).toBe('clean');
    expect(result.integrityFailures).toEqual([]);
  });
});
