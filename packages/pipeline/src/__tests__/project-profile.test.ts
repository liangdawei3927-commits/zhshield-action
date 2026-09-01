import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectProjectProfile } from '../project-profile';

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
