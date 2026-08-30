import { describe, expect, it, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildDependencyGraph } from '../graph-builder';
import { ROOT_NODE_ID } from '../types';

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

describe('buildDependencyGraph npm', () => {
  it('解析 package-lock.json v3：节点 / 直接间接标记 / 声明范围 / 许可证 / 完整性', () => {
    const dir = tmpDir('zh-dep-npm-v3-');
    writeFile(dir, 'package.json', JSON.stringify({
      name: 'app',
      dependencies: { react: '^18.2.0', lodash: '^4.17.21' },
      devDependencies: { typescript: '^5.7.0' },
    }));
    writeFile(dir, 'package-lock.json', JSON.stringify({
      name: 'app',
      lockfileVersion: 3,
      packages: {
        '': { name: 'app', dependencies: { react: '^18.2.0', lodash: '^4.17.21' } },
        'node_modules/react': { version: '18.2.0', integrity: 'sha512-react-hash', license: 'MIT' },
        'node_modules/lodash': { version: '4.17.21', integrity: 'sha512-lodash-hash', license: 'MIT' },
        'node_modules/scheduler': { version: '0.23.0', integrity: 'sha512-scheduler-hash' },
        'node_modules/typescript': { version: '5.7.2', integrity: 'sha512-typescript-hash', license: 'Apache-2.0' },
      },
    }));

    const graph = buildDependencyGraph(dir);

    expect(graph.schemaVersion).toBe(1);
    expect(graph.ecosystem).toBe('npm');
    expect(graph.nodes).toHaveLength(4);

    const react = graph.nodes.find((n) => n.name === 'react');
    expect(react).toBeDefined();
    expect(react?.id).toBe('react@18.2.0');
    expect(react?.kind).toBe('direct');
    expect(react?.declaredRange).toBe('^18.2.0');
    expect(react?.version).toBe('18.2.0');
    expect(react?.license).toBe('MIT');
    expect(react?.trust).toBe('verified');
    expect(react?.integrity).toBe('sha512-react-hash');
    expect(react?.vulnerabilities).toEqual([]);

    const scheduler = graph.nodes.find((n) => n.name === 'scheduler');
    expect(scheduler?.kind).toBe('transitive');
    expect(scheduler?.declaredRange).toBe('');

    const edges = graph.edges.filter((e) => e.from === ROOT_NODE_ID);
    expect(edges).toHaveLength(3);
    expect(edges).toContainEqual({ from: ROOT_NODE_ID, to: 'react@18.2.0', requirement: '^18.2.0' });
    expect(edges).toContainEqual({ from: ROOT_NODE_ID, to: 'typescript@5.7.2', requirement: '^5.7.0' });

    expect(graph.lockfile.present).toBe(true);
    expect(graph.lockfile.consistent).toBe(true);
    expect(graph.lockfile.integrityVerified).toBe(true);
    expect(graph.lockfile.lastModified).toBeDefined();
  });

  it('解析 package-lock.json v1 dependencies 嵌套结构', () => {
    const dir = tmpDir('zh-dep-npm-v1-');
    writeFile(dir, 'package.json', JSON.stringify({ dependencies: { lodash: '^4.17.21' } }));
    writeFile(dir, 'package-lock.json', JSON.stringify({
      name: 'app',
      lockfileVersion: 1,
      dependencies: {
        lodash: {
          version: '4.17.21',
          resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz',
          integrity: 'sha512-v1-hash',
          dependencies: {
            loadash: { version: '1.0.0' },
          },
        },
      },
    }));

    const graph = buildDependencyGraph(dir);

    expect(graph.nodes).toHaveLength(2);
    const lodash = graph.nodes.find((n) => n.name === 'lodash');
    expect(lodash?.kind).toBe('direct');
    expect(lodash?.declaredRange).toBe('^4.17.21');
    expect(lodash?.version).toBe('4.17.21');
    expect(lodash?.trust).toBe('verified');

    const loadash = graph.nodes.find((n) => n.name === 'loadash');
    expect(loadash?.kind).toBe('transitive');
    expect(loadash?.trust).toBe('unknown');

    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toEqual({ from: ROOT_NODE_ID, to: 'lodash@4.17.21', requirement: '^4.17.21' });
  });

  it('package-lock.json 损坏时不抛异常，返回空图谱', () => {
    const dir = tmpDir('zh-dep-npm-corrupt-');
    writeFile(dir, 'package-lock.json', '{not json');

    expect(() => buildDependencyGraph(dir)).not.toThrow();
    const graph = buildDependencyGraph(dir);
    expect(graph.nodes).toHaveLength(0);
    expect(graph.edges).toHaveLength(0);
    expect(graph.lockfile.present).toBe(false);
    expect(graph.lockfile.consistent).toBe(false);
  });

  it('锁定版本满足声明范围 → consistent=true（真实比对，非 present 别名）', () => {
    const dir = tmpDir('zh-dep-npm-consistent-ok-');
    writeFile(dir, 'package.json', JSON.stringify({ dependencies: { lodash: '^4.17.21' } }));
    writeFile(dir, 'package-lock.json', JSON.stringify({
      lockfileVersion: 3,
      packages: { 'node_modules/lodash': { version: '4.17.21', integrity: 'sha512-lodash-hash' } },
    }));

    const graph = buildDependencyGraph(dir);

    expect(graph.lockfile.consistent).toBe(true);
  });

  it('锁定版本违反声明范围 → consistent=false', () => {
    const dir = tmpDir('zh-dep-npm-consistent-bad-');
    writeFile(dir, 'package.json', JSON.stringify({ dependencies: { lodash: '^4.17.21' } }));
    writeFile(dir, 'package-lock.json', JSON.stringify({
      lockfileVersion: 3,
      packages: { 'node_modules/lodash': { version: '5.0.0', integrity: 'sha512-lodash-tampered' } },
    }));

    const graph = buildDependencyGraph(dir);

    expect(graph.lockfile.present).toBe(true);
    expect(graph.lockfile.consistent).toBe(false);
  });
});

describe('buildDependencyGraph pnpm', () => {
  it('解析 pnpm-lock.yaml v6+：importers 直接依赖 + packages 完整性', () => {
    const dir = tmpDir('zh-dep-pnpm-');
    writeFile(dir, 'pnpm-lock.yaml', [
      "lockfileVersion: '9.0'",
      'importers:',
      '  .:',
      '    dependencies:',
      '      lodash:',
      '        specifier: ^4.17.21',
      '        version: 4.17.21',
      '    devDependencies:',
      '      vitest:',
      '        specifier: ^4.1.0',
      '        version: 4.1.10',
      'packages:',
      '  /lodash@4.17.21:',
      '    resolution: {integrity: sha512-pnpm-lodash}',
      '  /@babel/core@7.24.0:',
      '    resolution: {integrity: sha512-pnpm-babel}',
      '  /vitest@4.1.10:',
      '    resolution: {integrity: sha512-pnpm-vitest}',
    ].join('\n'));

    const graph = buildDependencyGraph(dir);

    expect(graph.ecosystem).toBe('npm');
    const lodash = graph.nodes.find((n) => n.name === 'lodash');
    expect(lodash?.kind).toBe('direct');
    expect(lodash?.declaredRange).toBe('^4.17.21');
    expect(lodash?.version).toBe('4.17.21');
    expect(lodash?.trust).toBe('verified');
    expect(lodash?.integrity).toBe('sha512-pnpm-lodash');

    const vitest = graph.nodes.find((n) => n.name === 'vitest');
    expect(vitest?.kind).toBe('direct');
    expect(vitest?.declaredRange).toBe('^4.1.0');
    expect(vitest?.trust).toBe('verified');

    const babel = graph.nodes.find((n) => n.name === '@babel/core');
    expect(babel?.kind).toBe('transitive');
    expect(babel?.trust).toBe('verified');

    const edges = graph.edges.filter((e) => e.from === ROOT_NODE_ID);
    expect(edges).toHaveLength(2);
    expect(edges).toContainEqual({ from: ROOT_NODE_ID, to: 'lodash@4.17.21', requirement: '^4.17.21' });
    expect(edges).toContainEqual({ from: ROOT_NODE_ID, to: 'vitest@4.1.10', requirement: '^4.1.0' });

    expect(graph.lockfile.present).toBe(true);
    expect(graph.lockfile.integrityVerified).toBe(true);
  });

  it('处理 scoped 包与 peer 依赖后缀的 packages 键', () => {
    const dir = tmpDir('zh-dep-pnpm-scoped-');
    writeFile(dir, 'pnpm-lock.yaml', [
      "lockfileVersion: '9.0'",
      'importers:',
      '  .:',
      '    dependencies:',
      '      foo:',
      '        specifier: ^1.0.0',
      '        version: 1.0.0',
      'packages:',
      '  /foo@1.0.0(bar@2.0.0):',
      '    resolution: {integrity: sha512-foo-hash}',
      '  /@babel/core@7.24.0:',
      '    resolution: {integrity: sha512-babel-hash}',
    ].join('\n'));

    const graph = buildDependencyGraph(dir);

    const foo = graph.nodes.find((n) => n.name === 'foo');
    expect(foo?.version).toBe('1.0.0');
    expect(foo?.trust).toBe('verified');

    const babel = graph.nodes.find((n) => n.name === '@babel/core');
    expect(babel?.version).toBe('7.24.0');
    expect(babel?.kind).toBe('transitive');
  });

  it('解析 pnpm v9（pnpm 10/11）锁文件：packages 键无前导斜杠 + importers 版本带 peer 后缀', () => {
    const dir = tmpDir('zh-dep-pnpm-v9-');
    writeFile(dir, 'pnpm-lock.yaml', [
      "lockfileVersion: '9.0'",
      'importers:',
      '  .:',
      '    dependencies:',
      '      vitest:',
      '        specifier: ^4.1.0',
      '        version: 4.1.10(vitest@4.1.10)',
      'packages:',
      "  'vitest@4.1.10(vitest@4.1.10)':",
      '    resolution: {integrity: sha512-vitest-v9-hash}',
      "  '@babel/core@7.24.0':",
      '    resolution: {integrity: sha512-babel-v9-hash}',
      "  'lodash@4.17.21':",
      '    resolution: {integrity: sha512-lodash-v9-hash}',
    ].join('\n'));

    const graph = buildDependencyGraph(dir);

    const vitest = graph.nodes.find((n) => n.name === 'vitest');
    expect(vitest?.kind).toBe('direct');
    expect(vitest?.version).toBe('4.1.10');
    expect(vitest?.trust).toBe('verified');
    expect(vitest?.integrity).toBe('sha512-vitest-v9-hash');

    const lodash = graph.nodes.find((n) => n.name === 'lodash');
    expect(lodash?.kind).toBe('transitive');
    expect(lodash?.trust).toBe('verified');

    const babel = graph.nodes.find((n) => n.name === '@babel/core');
    expect(babel?.kind).toBe('transitive');
    expect(babel?.integrity).toBe('sha512-babel-v9-hash');

    expect(graph.nodes).toHaveLength(3);
    expect(graph.lockfile.integrityVerified).toBe(true);
  });
});

describe('buildDependencyGraph yarn', () => {
  it('解析 yarn.lock v1：直接依赖来自 package.json，锁定版本来自块', () => {
    const dir = tmpDir('zh-dep-yarn-');
    writeFile(dir, 'package.json', JSON.stringify({
      dependencies: { lodash: '^4.17.21', react: '^18.2.0' },
    }));
    writeFile(dir, 'yarn.lock', [
      '# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.',
      '# yarn lockfile v1',
      '',
      '"lodash@^4.17.21":',
      '  version "4.17.21"',
      '  resolved "https://registry.yarnpkg.com/lodash/-/lodash-4.17.21.tgz#aa"',
      '  integrity sha512-yarn-lodash',
      '',
      '"react@^18.2.0":',
      '  version "18.2.0"',
      '  resolved "https://registry.yarnpkg.com/react/-/react-18.2.0.tgz#bb"',
      '  integrity sha512-yarn-react',
      '',
      '"scheduler@^0.23.0":',
      '  version "0.23.0"',
      '  resolved "https://registry.yarnpkg.com/scheduler/-/scheduler-0.23.0.tgz#cc"',
    ].join('\n'));

    const graph = buildDependencyGraph(dir);

    const lodash = graph.nodes.find((n) => n.name === 'lodash');
    expect(lodash?.kind).toBe('direct');
    expect(lodash?.version).toBe('4.17.21');
    expect(lodash?.declaredRange).toBe('^4.17.21');
    expect(lodash?.trust).toBe('verified');
    expect(lodash?.integrity).toBe('sha512-yarn-lodash');

    const scheduler = graph.nodes.find((n) => n.name === 'scheduler');
    expect(scheduler?.kind).toBe('transitive');
    expect(scheduler?.version).toBe('0.23.0');
    expect(scheduler?.trust).toBe('unknown');

    const edges = graph.edges.filter((e) => e.from === ROOT_NODE_ID);
    expect(edges).toHaveLength(2);
    expect(edges).toContainEqual({ from: ROOT_NODE_ID, to: 'react@18.2.0', requirement: '^18.2.0' });
    expect(graph.lockfile.present).toBe(true);
  });
});

describe('buildDependencyGraph python', () => {
  it('pyproject.toml [project] 声明 + poetry.lock 版本 → ecosystem pip', () => {
    const dir = tmpDir('zh-dep-poetry-');
    writeFile(dir, 'pyproject.toml', [
      '[project]',
      'name = "demo"',
      'version = "0.1.0"',
      'dependencies = [',
      '    "flask>=2.3",',
      '    "requests==2.31.0",',
      ']',
    ].join('\n'));
    writeFile(dir, 'poetry.lock', [
      '# This file is automatically @generated by Poetry.',
      '[[package]]',
      'name = "flask"',
      'version = "2.3.3"',
      'description = "A simple framework"',
      '',
      '[[package]]',
      'name = "requests"',
      'version = "2.31.0"',
      'description = "HTTP for Humans"',
      '',
      '[[package]]',
      'name = "werkzeug"',
      'version = "3.0.1"',
      'description = "WSGI utils"',
    ].join('\n'));

    const graph = buildDependencyGraph(dir);

    expect(graph.ecosystem).toBe('pip');
    const flask = graph.nodes.find((n) => n.name === 'flask');
    expect(flask?.kind).toBe('direct');
    expect(flask?.declaredRange).toBe('>=2.3');
    expect(flask?.version).toBe('2.3.3');

    const requests = graph.nodes.find((n) => n.name === 'requests');
    expect(requests?.kind).toBe('direct');
    expect(requests?.declaredRange).toBe('==2.31.0');
    expect(requests?.version).toBe('2.31.0');

    const werkzeug = graph.nodes.find((n) => n.name === 'werkzeug');
    expect(werkzeug?.kind).toBe('transitive');
    expect(werkzeug?.declaredRange).toBe('');

    const edges = graph.edges.filter((e) => e.from === ROOT_NODE_ID);
    expect(edges).toContainEqual({ from: ROOT_NODE_ID, to: 'flask@2.3.3', requirement: '>=2.3' });
    expect(graph.lockfile.present).toBe(true);
  });

  it('解析 Pipfile.lock：default / develop 区块，跳过 _meta', () => {
    const dir = tmpDir('zh-dep-pipfile-');
    writeFile(dir, 'Pipfile.lock', JSON.stringify({
      _meta: { hash: { sha256: 'abc' } },
      default: {
        flask: { version: '==2.3.3', hashes: ['sha256:xxx'] },
      },
      develop: {
        pytest: { version: '==8.0.0' },
      },
    }));

    const graph = buildDependencyGraph(dir);

    const flask = graph.nodes.find((n) => n.name === 'flask');
    expect(flask?.version).toBe('2.3.3');
    expect(flask?.declaredRange).toBe('==2.3.3');
    expect(flask?.kind).toBe('direct');

    const pytest = graph.nodes.find((n) => n.name === 'pytest');
    expect(pytest?.version).toBe('8.0.0');

    expect(graph.nodes.some((n) => n.name === '_meta')).toBe(false);
    expect(graph.lockfile.present).toBe(true);
  });

  it('解析 requirements.txt：剥离注释 / 选项行 / extras / 环境标记', () => {
    const dir = tmpDir('zh-dep-req-');
    writeFile(dir, 'requirements.txt', [
      '# 依赖清单',
      'flask==2.3.3',
      'requests>=2.31.0',
      'uvicorn[standard]==0.29.0  # ASGI server',
      '-e .',
      '-r other.txt',
      '--index-url https://pypi.org/simple',
      'pydantic; python_version >= "3.8"',
    ].join('\n'));

    const graph = buildDependencyGraph(dir);

    expect(graph.ecosystem).toBe('pip');
    const flask = graph.nodes.find((n) => n.name === 'flask');
    expect(flask?.version).toBe('2.3.3');
    expect(flask?.declaredRange).toBe('==2.3.3');

    const requests = graph.nodes.find((n) => n.name === 'requests');
    expect(requests?.version).toBe('2.31.0');
    expect(requests?.declaredRange).toBe('>=2.31.0');

    const uvicorn = graph.nodes.find((n) => n.name === 'uvicorn');
    expect(uvicorn?.version).toBe('0.29.0');

    const pydantic = graph.nodes.find((n) => n.name === 'pydantic');
    expect(pydantic).toBeDefined();

    const names = graph.nodes.map((n) => n.name);
    expect(names).not.toContain('editable');
    expect(names).not.toContain('other.txt');
    expect(graph.lockfile.present).toBe(false);
    expect(graph.lockfile.consistent).toBe(false);
  });

  it('pyproject.toml 仅有 [tool.poetry.dependencies]（无锁文件）', () => {
    const dir = tmpDir('zh-dep-pyproject-');
    writeFile(dir, 'pyproject.toml', [
      '[tool.poetry]',
      'name = "demo"',
      'version = "0.1.0"',
      '',
      '[tool.poetry.dependencies]',
      'python = "^3.11"',
      'flask = "^2.3"',
      'click = { version = "^8.1", python = ">=3.9" }',
    ].join('\n'));

    const graph = buildDependencyGraph(dir);

    expect(graph.ecosystem).toBe('pip');
    const flask = graph.nodes.find((n) => n.name === 'flask');
    expect(flask?.kind).toBe('direct');
    expect(flask?.version).toBe('2.3');
    expect(flask?.declaredRange).toBe('^2.3');

    const click = graph.nodes.find((n) => n.name === 'click');
    expect(click?.declaredRange).toBe('^8.1');
    expect(click?.version).toBe('8.1');

    expect(graph.nodes.some((n) => n.name === 'python')).toBe(false);
    expect(graph.lockfile.present).toBe(false);
  });
});

describe('buildDependencyGraph 边界', () => {
  it('无任何清单 → 空图谱且 lockfile.present=false', () => {
    const dir = tmpDir('zh-dep-empty-');

    const graph = buildDependencyGraph(dir);

    expect(graph.nodes).toHaveLength(0);
    expect(graph.edges).toHaveLength(0);
    expect(graph.lockfile.present).toBe(false);
    expect(graph.lockfile.consistent).toBe(false);
    expect(graph.lockfile.integrityVerified).toBe(false);
    expect(graph.targetId).toBe(path.basename(dir));
  });

  it('支持自定义 targetId', () => {
    const dir = tmpDir('zh-dep-target-');
    writeFile(dir, 'package.json', JSON.stringify({ dependencies: {} }));
    writeFile(dir, 'package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: {} }));

    const graph = buildDependencyGraph(dir, { targetId: 'my-app' });

    expect(graph.targetId).toBe('my-app');
  });
});
