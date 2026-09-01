import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseRunCommand, detectRunCommand, discoverLogPaths } from '../project-probe';

function makeProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

describe('parseRunCommand', () => {
  it('returns dev script when present', () => {
    expect(parseRunCommand(JSON.stringify({ scripts: { dev: 'vite', build: 'tsc' } }))).toEqual({
      script: 'dev',
      command: 'npm run dev',
    });
  });

  it('falls back to start then build when dev is absent', () => {
    expect(
      parseRunCommand(JSON.stringify({ scripts: { start: 'node server.js', build: 'tsc' } })),
    ).toEqual({
      script: 'start',
      command: 'npm run start',
    });
    expect(parseRunCommand(JSON.stringify({ scripts: { build: 'tsc' } }))).toEqual({
      script: 'build',
      command: 'npm run build',
    });
  });

  it('returns null when no scripts or empty script', () => {
    expect(parseRunCommand(JSON.stringify({ name: 'x' }))).toBeNull();
    expect(parseRunCommand(JSON.stringify({ scripts: { dev: '   ' } }))).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(parseRunCommand('not json')).toBeNull();
  });
});

describe('detectRunCommand', () => {
  it('reads package.json from project path', () => {
    const dir = makeProject({ 'package.json': JSON.stringify({ scripts: { dev: 'next dev' } }) });
    expect(detectRunCommand(dir)).toEqual({ script: 'dev', command: 'npm run dev' });
  });

  it('returns null when project has no package.json', () => {
    const dir = makeProject({ 'src/index.ts': 'export {}' });
    expect(detectRunCommand(dir)).toBeNull();
  });
});

describe('discoverLogPaths', () => {
  it('finds logs under logs/ and root, newest first', () => {
    const dir = makeProject({
      'logs/app.log': 'old',
      'logs/error.log': 'newest',
      'out.log': 'root',
    });
    // 写入顺序决定 mtime，手动确保 error.log 最新
    const errorPath = path.join(dir, 'logs', 'error.log');
    const future = new Date(Date.now() + 1000);
    fs.utimesSync(errorPath, future, future);

    const paths = discoverLogPaths(dir);
    expect(paths).toContain(path.join(dir, 'logs', 'app.log'));
    expect(paths).toContain(path.join(dir, 'logs', 'error.log'));
    expect(paths).toContain(path.join(dir, 'out.log'));
    expect(paths[0]).toBe(errorPath);
  });

  it('respects limit and ignores non-log files', () => {
    const dir = makeProject({
      'logs/a.log': '1',
      'logs/b.log': '2',
      'logs/c.log': '3',
      'logs/readme.txt': 'no',
    });
    expect(discoverLogPaths(dir, 2)).toHaveLength(2);
  });

  it('returns empty when no log files exist', () => {
    const dir = makeProject({ 'src/main.ts': 'export {}' });
    expect(discoverLogPaths(dir)).toEqual([]);
  });
});
