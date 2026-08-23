import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ProjectProfiler } from '../profiler';

let tmpDir: string;

function writeFile(relPath: string, content: string): void {
  const abs = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zh-profiler-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('ProjectProfiler', () => {
  const profiler = new ProjectProfiler();

  it('TS/NestJS 后端项目探测', () => {
    writeFile('package.json', JSON.stringify({
      name: 'demo-backend',
      dependencies: { '@nestjs/core': '^10.0.0', '@nestjs/common': '^10.0.0' },
    }));
    writeFile('tsconfig.json', '{}');
    writeFile('pnpm-lock.yaml', 'lockfileVersion: 6.0');
    writeFile('src/main.ts', 'console.log("hi");');

    const result = profiler.profileSync(tmpDir);
    expect(result.profile.language).toBe('typescript');
    expect(result.profile.framework).toBe('nestjs');
    expect(result.profile.type).toBe('backend');
    expect(result.profile.packageManager).toBe('pnpm');
    expect(result.profile.isMonorepo).toBe(false);
    expect(result.profile.confidence).toBeGreaterThan(0);
  });

  it('React 前端项目探测', () => {
    writeFile('package.json', JSON.stringify({
      name: 'demo-frontend',
      dependencies: { react: '^18.0.0', 'react-dom': '^18.0.0' },
    }));
    writeFile('src/App.tsx', 'export default () => null;');

    const result = profiler.profileSync(tmpDir);
    expect(result.profile.language).toBe('typescript');
    expect(result.profile.framework).toBe('react');
    expect(result.profile.type).toBe('frontend');
  });

  it('Go 项目探测', () => {
    writeFile('go.mod', 'module github.com/demo/api\n\ngo 1.21\n');
    writeFile('go.sum', '');
    writeFile('main.go', 'package main\n\nfunc main() {}\n');

    const result = profiler.profileSync(tmpDir);
    expect(result.profile.language).toBe('go');
    expect(result.profile.packageManager).toBe('go-mod');
    expect(result.profile.runtime).toBe('go');
  });

  it('Python/Django 项目探测', () => {
    writeFile('requirements.txt', 'django==4.2\ndjangorestframework==3.14\n');
    writeFile('manage.py', '#!/usr/bin/env python');

    const result = profiler.profileSync(tmpDir);
    expect(result.profile.language).toBe('python');
    expect(result.profile.framework).toBe('django');
    expect(result.profile.runtime).toBe('python');
  });

  it('Electron 桌面端项目探测', () => {
    writeFile('package.json', JSON.stringify({
      name: 'demo-desktop',
      main: 'electron/main.js',
      dependencies: { electron: '^42.0.0' },
    }));
    writeFile('electron/main.js', 'console.log("main");');

    const result = profiler.profileSync(tmpDir);
    expect(result.profile.framework).toBe('electron');
    expect(result.profile.type).toBe('desktop');
    expect(result.profile.runtime).toBe('electron');
  });

  it('微信小程序项目探测', () => {
    writeFile('project.config.json', JSON.stringify({ appid: 'wx1234' }));
    writeFile('app.json', '{}');
    writeFile('app.js', 'App({})');

    const result = profiler.profileSync(tmpDir);
    expect(result.profile.framework).toBe('weapp');
    expect(result.profile.type).toBe('mini-program');
  });

  it('Monorepo 项目探测并展开模块', () => {
    writeFile('pnpm-workspace.yaml', 'packages:\n  - "packages/*"\n');
    writeFile('packages/server/package.json', JSON.stringify({
      name: '@demo/server',
      dependencies: { '@nestjs/core': '^10.0.0' },
    }));
    writeFile('packages/web/package.json', JSON.stringify({
      name: '@demo/web',
      dependencies: { react: '^18.0.0' },
    }));

    const result = profiler.profileSync(tmpDir);
    expect(result.profile.isMonorepo).toBe(true);
    expect(result.profile.type).toBe('monorepo');
    expect(result.profile.modules).toBeDefined();
    expect(result.profile.modules!.length).toBeGreaterThanOrEqual(2);
  });

  it('不存在的目录降级为 unknown', () => {
    const result = profiler.profileSync('/nonexistent/path/xyz');
    expect(result.profile.language).toBe('unknown');
    expect(result.profile.type).toBe('unknown');
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('CLI 工具项目探测', () => {
    writeFile('package.json', JSON.stringify({
      name: 'demo-cli',
      bin: { 'demo-cli': './bin/cli.js' },
    }));

    const result = profiler.profileSync(tmpDir);
    expect(result.profile.type).toBe('cli');
  });

  it('探测信号留痕可用于审计', () => {
    writeFile('package.json', JSON.stringify({ dependencies: { '@nestjs/core': '^10.0.0' } }));
    writeFile('tsconfig.json', '{}');

    const result = profiler.profileSync(tmpDir);
    expect(result.profile.signals.length).toBeGreaterThan(0);
    const configFileSignals = result.profile.signals.filter((s) => s.kind === 'config-file');
    expect(configFileSignals.length).toBeGreaterThan(0);
    expect(result.profile.detectedFiles).toContain('package.json');
    expect(result.profile.detectedFiles).toContain('tsconfig.json');
  });
});
