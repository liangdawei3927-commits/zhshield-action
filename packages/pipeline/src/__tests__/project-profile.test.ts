import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  detectNestedProjectSuggestion,
  detectProjectProfile,
  resolveEffectiveProjectRoot,
} from '../project-profile';
import { deriveProjectFeature } from '../pipeline-runner-phase-helpers';

describe('detectProjectProfile — M0 项目识别', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zh-profile-'));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('识别 TypeScript + NestJS + pnpm 项目', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({
        name: 'demo',
        dependencies: { '@nestjs/core': '^10', rxjs: '^7' },
        devDependencies: { typescript: '^5' },
      }),
    );
    fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{}');
    fs.writeFileSync(path.join(tmpDir, 'pnpm-lock.yaml'), '');

    const profile = detectProjectProfile(tmpDir);
    expect(profile.language).toBe('typescript');
    expect(profile.framework).toBe('NestJS');
    expect(profile.packageManager).toBe('pnpm');
    expect(profile.hasTypeScript).toBe(true);
  });

  it('识别 JavaScript + Express + npm 项目', () => {
    const jsDir = path.join(tmpDir, 'js-express');
    fs.mkdirSync(jsDir, { recursive: true });
    fs.writeFileSync(
      path.join(jsDir, 'package.json'),
      JSON.stringify({
        name: 'js-demo',
        dependencies: { express: '^4' },
      }),
    );
    fs.writeFileSync(path.join(jsDir, 'package-lock.json'), '');

    const profile = detectProjectProfile(jsDir);
    expect(profile.language).toBe('javascript');
    expect(profile.framework).toBe('Express');
    expect(profile.packageManager).toBe('npm');
    expect(profile.hasTypeScript).toBe(false);
  });

  it('无 package.json 时按未知语言处理', () => {
    const emptyDir = path.join(tmpDir, 'empty');
    fs.mkdirSync(emptyDir, { recursive: true });

    const profile = detectProjectProfile(emptyDir);
    expect(profile.language).toBe('unknown');
    expect(profile.framework).toBeNull();
    expect(profile.packageManager).toBe('unknown');
    expect(profile.hasTypeScript).toBe(false);
  });

  it('识别 Python + Django + Poetry 项目', () => {
    const pyDir = path.join(tmpDir, 'py-django');
    fs.mkdirSync(pyDir, { recursive: true });
    fs.writeFileSync(
      path.join(pyDir, 'pyproject.toml'),
      ['[project]', 'dependencies = ["django==4.2.0", "gunicorn==21.2.0"]'].join('\n'),
    );
    fs.writeFileSync(path.join(pyDir, 'poetry.lock'), '');

    const profile = detectProjectProfile(pyDir);
    expect(profile.language).toBe('python');
    expect(profile.framework).toBe('Django');
    expect(profile.packageManager).toBe('poetry');
    expect(profile.hasTypeScript).toBe(false);
  });

  it('识别 Python + FastAPI + pip 项目', () => {
    const pyDir = path.join(tmpDir, 'py-fastapi');
    fs.mkdirSync(pyDir, { recursive: true });
    fs.writeFileSync(path.join(pyDir, 'requirements.txt'), 'fastapi==0.100.0\n');

    const profile = detectProjectProfile(pyDir);
    expect(profile.language).toBe('python');
    expect(profile.framework).toBe('FastAPI');
    expect(profile.packageManager).toBe('pip');
    expect(profile.hasTypeScript).toBe(false);
  });

  it('仅 setup.py 时识别 Python，包管理器未知', () => {
    const pyDir = path.join(tmpDir, 'py-setup');
    fs.mkdirSync(pyDir, { recursive: true });
    fs.writeFileSync(path.join(pyDir, 'setup.py'), 'from setuptools import setup\n');

    const profile = detectProjectProfile(pyDir);
    expect(profile.language).toBe('python');
    expect(profile.framework).toBeNull();
    expect(profile.packageManager).toBe('unknown');
    expect(profile.hasTypeScript).toBe(false);
  });

  it('uv.lock + pyproject.toml 时包管理器为 uv', () => {
    const pyDir = path.join(tmpDir, 'py-uv');
    fs.mkdirSync(pyDir, { recursive: true });
    fs.writeFileSync(
      path.join(pyDir, 'pyproject.toml'),
      ['[project]', 'dependencies = ["flask>=3.0"]'].join('\n'),
    );
    fs.writeFileSync(path.join(pyDir, 'uv.lock'), '');

    const profile = detectProjectProfile(pyDir);
    expect(profile.language).toBe('python');
    expect(profile.packageManager).toBe('uv');
    expect(profile.hasTypeScript).toBe(false);
  });
});

describe('resolveEffectiveProjectRoot — 容器目录下探唯一嵌套仓库根', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zh-nested-root-'));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeProjectDir(rel: string, pkg: Record<string, unknown>): string {
    const dir = path.join(tmpDir, rel);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
    return dir;
  }

  it('容器目录含唯一嵌套仓库 → 解析为该子目录（补检场景根因）', () => {
    const container = path.join(tmpDir, 'container-unique');
    const nested = makeProjectDir('container-unique/real-project', { name: 'real' });
    fs.writeFileSync(path.join(container, 'readme.txt'), 'docs only');

    expect(resolveEffectiveProjectRoot(container)).toBe(nested);
  });

  it('目标本身是 git 仓库 → 不下探嵌套仓库（内外分离仓库扫描 2026-11-09）', () => {
    // 复刻真实结构：文档仓（带 .git、无 package.json）里放着一份被 .gitignore
    // 排除的完整代码仓。目标自身是仓库 ⇒ 子目录属于**另一个项目**，不得改扫它。
    const container = path.join(tmpDir, 'repo-with-nested');
    fs.mkdirSync(path.join(container, '.git'), { recursive: true });
    makeProjectDir('repo-with-nested/nested-monorepo', { name: 'nested' });

    expect(resolveEffectiveProjectRoot(container)).toBe(container);
  });

  it('目标本身有 package.json → 原样返回', () => {
    const project = makeProjectDir('self-project', { name: 'self' });
    expect(resolveEffectiveProjectRoot(project)).toBe(project);
  });

  it('Python 项目（无 package.json，有 pyproject.toml）→ 原样返回', () => {
    const pyDir = path.join(tmpDir, 'py-root');
    fs.mkdirSync(pyDir, { recursive: true });
    fs.writeFileSync(path.join(pyDir, 'pyproject.toml'), '[project]\n');

    expect(resolveEffectiveProjectRoot(pyDir)).toBe(pyDir);
  });

  it('无候选（空容器）→ 原样返回', () => {
    const empty = path.join(tmpDir, 'container-empty');
    fs.mkdirSync(empty, { recursive: true });
    fs.writeFileSync(path.join(empty, 'note.md'), '');

    expect(resolveEffectiveProjectRoot(empty)).toBe(empty);
  });

  it('多候选（两个嵌套项目）→ 不猜测，原样返回', () => {
    const container = path.join(tmpDir, 'container-multi');
    makeProjectDir('container-multi/project-a', { name: 'a' });
    makeProjectDir('container-multi/project-b', { name: 'b' });

    expect(resolveEffectiveProjectRoot(container)).toBe(container);
  });

  it('点开头与噪声目录中的 package.json 不作为候选', () => {
    const container = path.join(tmpDir, 'container-noise');
    makeProjectDir('container-noise/node_modules/ghost', { name: 'ghost' });
    makeProjectDir('container-noise/.hidden/ghost', { name: 'ghost' });
    const real = makeProjectDir('container-noise/real', { name: 'real' });

    expect(resolveEffectiveProjectRoot(container)).toBe(real);
  });

  it('清单损坏的子目录不作为候选（可避免静默扫错目标）', () => {
    const container = path.join(tmpDir, 'container-broken');
    fs.mkdirSync(path.join(container, 'broken'), { recursive: true });
    fs.writeFileSync(path.join(container, 'broken', 'package.json'), '{ not json');
    const real = makeProjectDir('container-broken/real', { name: 'real' });

    expect(resolveEffectiveProjectRoot(container)).toBe(real);
  });

  it('回归：容器路径经 deriveProjectFeature 得到 typescript 画像（ts-prune 不再被 scope 裁剪）', () => {
    const container = path.join(tmpDir, 'container-feature');
    const nested = makeProjectDir('container-feature/zhihui-like', {
      name: 'repo-root',
      devDependencies: { typescript: '^5' },
    });
    fs.writeFileSync(path.join(nested, 'tsconfig.json'), '{}');

    // 不下探时容器画像为 unknown（无 language 字段）→ ts-prune 被裁剪；下探后应识别 typescript
    expect(deriveProjectFeature(container)?.language).toBe('typescript');
  });
});

/**
 * 子项目建议：只提示、不改判。
 *
 * 与 resolveEffectiveProjectRoot 的区别在于目标带 `.git` 时仍然给建议 ——
 * 扫描根不会被改（那个函数负责"扫描根是谁"），本函数只负责"要不要问用户一句"。
 */
describe('detectNestedProjectSuggestion — 子项目建议（只提示不改判）', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zh-nested-suggest-'));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeProjectDir(rel: string, pkg: Record<string, unknown>): string {
    const dir = path.join(tmpDir, rel);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
    return dir;
  }

  it('容器含唯一嵌套项目 → 给出建议（路径 + 目录名）', () => {
    const container = path.join(tmpDir, 'suggest-unique');
    const nested = makeProjectDir('suggest-unique/inner-repo', { name: 'inner' });
    fs.mkdirSync(container, { recursive: true });
    fs.writeFileSync(path.join(container, 'readme.txt'), 'docs only');

    expect(detectNestedProjectSuggestion(container)).toEqual({
      path: nested,
      name: 'inner-repo',
    });
  });

  it('目标带 .git 且无清单 → 仍然给出建议（不参与扫描根解析，不构成改判）', () => {
    const container = path.join(tmpDir, 'suggest-git-container');
    makeProjectDir('suggest-git-container/inner-repo', { name: 'inner' });
    fs.mkdirSync(path.join(container, '.git'), { recursive: true });

    expect(detectNestedProjectSuggestion(container)?.name).toBe('inner-repo');
    // 同一个目录：扫描根解析仍然不下探（两条语义分开，互不影响）
    expect(resolveEffectiveProjectRoot(container)).toBe(container);
  });

  it('目标自身有 package.json → 不给建议', () => {
    const project = makeProjectDir('suggest-self', { name: 'self' });
    expect(detectNestedProjectSuggestion(project)).toBeNull();
  });

  it('多个候选 → 不猜测，不给建议', () => {
    const container = path.join(tmpDir, 'suggest-multi');
    makeProjectDir('suggest-multi/a', { name: 'a' });
    makeProjectDir('suggest-multi/b', { name: 'b' });
    fs.mkdirSync(container, { recursive: true });

    expect(detectNestedProjectSuggestion(container)).toBeNull();
  });
});
