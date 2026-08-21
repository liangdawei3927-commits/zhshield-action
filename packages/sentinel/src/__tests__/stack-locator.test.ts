import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseV8Stack, deriveModule, locateWithSourceMap, fallbackLocation, locateCrash } from '../stack-locator';

const V8_STACK = `TypeError: Cannot read properties of undefined (reading 'name')
    at getOrder (webpack:///src/modules/order/order.service.ts:42:15)
    at handler (file:///app/dist/server.js:120:10)
    at processTicksAndRejections (node:internal/process/task_queues:95:5)`;

describe('parseV8Stack', () => {
  it('parses frames with function name, file, line, column', () => {
    const frames = parseV8Stack(V8_STACK);
    expect(frames).toHaveLength(3);
    expect(frames[0]).toEqual({
      functionName: 'getOrder',
      file: 'webpack:///src/modules/order/order.service.ts',
      line: 42,
      column: 15,
    });
    expect(frames[1].file).toBe('file:///app/dist/server.js');
    expect(frames[2]).toEqual({
      functionName: 'processTicksAndRejections',
      file: 'node:internal/process/task_queues',
      line: 95,
      column: 5,
    });
  });

  it('parses frames without function name', () => {
    const frames = parseV8Stack(`Error: boom
    at /app/dist/index.js:10:5`);
    expect(frames).toHaveLength(1);
    expect(frames[0].functionName).toBeUndefined();
    expect(frames[0].line).toBe(10);
  });

  it('parses async frames', () => {
    const frames = parseV8Stack(`Error
    at async loadUser (webpack:///src/modules/user/user.service.ts:7:3)`);
    expect(frames[0].functionName).toBe('async loadUser');
    expect(frames[0].line).toBe(7);
  });

  it('ignores non-frame lines', () => {
    const frames = parseV8Stack(`Error: x
    at foo (/a.ts:1:2)
    some random text`);
    expect(frames).toHaveLength(1);
  });
});

describe('deriveModule', () => {
  it('derives module from modules/ directory', () => {
    expect(deriveModule('src/modules/user/user.service.ts')).toBe('user');
    expect(deriveModule('src/modules/order/order.service.ts')).toBe('order');
  });

  it('falls back to parent directory name', () => {
    expect(deriveModule('src/utils/format.ts')).toBe('utils');
    expect(deriveModule('app/main.js')).toBe('app');
  });
});

describe('locateWithSourceMap', () => {
  function buildProject(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smap-'));
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(dir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    return dir;
  }

  it('maps minified coordinates back to source file', () => {
    const dir = buildProject({
      'dist/server.js': 'console.log("hello");\n',
      'dist/server.js.map': JSON.stringify({
        version: 3,
        file: 'server.js',
        sources: ['src/main.ts'],
        names: [],
        mappings: 'AAAA;AACA', // line1→(0,0), line2→(1,0)
      }),
      'src/main.ts': 'export const a = 1;\nexport const b = 2;\n',
    });

    const located = locateWithSourceMap(
      { functionName: 'handler', file: path.join(dir, 'dist/server.js'), line: 2, column: 8 },
      JSON.parse(fs.readFileSync(path.join(dir, 'dist/server.js.map'), 'utf-8')),
      dir,
    );

    expect(located).not.toBeNull();
    expect(located!.file).toBe('src/main.ts');
    expect(located!.line).toBe(2);
    expect(located!.module).toBe('main');
    expect(located!.snippet).toBe('export const b = 2;');
  });

  it('returns null when no segment matches the line', () => {
    const map = { version: 3, sources: ['src/a.ts'], names: [], mappings: 'AAAA;' };
    const located = locateWithSourceMap(
      { file: '/x/dist/a.js', line: 10, column: 1 },
      map,
    );
    expect(located).toBeNull();
  });
});

describe('locateCrash', () => {
  function buildProject(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loc-'));
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(dir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    return dir;
  }

  it('locates via sourcemap and skips node internals', () => {
    const dir = buildProject({
      'dist/server.js': 'console.log(1);\n',
      'dist/server.js.map': JSON.stringify({
        version: 3,
        sources: ['src/modules/order/order.service.ts'],
        names: [],
        mappings: 'AAAA;AACA',
      }),
      'src/modules/order/order.service.ts': 'export function getOrder() {}\nexport function calc() {}\n',
    });

    const stack = `TypeError: boom
    at getOrder (${path.join(dir, 'dist/server.js')}:2:15)
    at processTicksAndRejections (node:internal/process/task_queues:95:5)`;

    const located = locateCrash(stack, { projectPath: dir });
    expect(located).not.toBeNull();
    expect(located!.file).toBe('src/modules/order/order.service.ts');
    expect(located!.line).toBe(2);
    expect(located!.module).toBe('order');
  });

  it('falls back to coarse location when no sourcemap exists', () => {
    const dir = buildProject({
      'src/app/main.ts': 'export const x = 1;\nexport const y = 2;\n',
    });

    const stack = `Error: nope
    at start (${path.join(dir, 'src/app/main.ts')}:2:5)`;

    const located = locateCrash(stack, { projectPath: dir });
    expect(located).not.toBeNull();
    expect(located!.file).toBe(path.join(dir, 'src/app/main.ts'));
    expect(located!.line).toBe(2);
    expect(located!.module).toBe('app');
    expect(located!.snippet).toBe('export const y = 2;');
  });

  it('returns null for stack with only node internals', () => {
    const located = locateCrash(`Error
    at processTicksAndRejections (node:internal/process/task_queues:95:5)`);
    expect(located).toBeNull();
  });
});

describe('fallbackLocation', () => {
  it('keeps frame coordinates when no project path is available', () => {
    const located = fallbackLocation({ functionName: 'f', file: '/app/main.js', line: 3, column: 7 });
    expect(located.file).toBe('/app/main.js');
    expect(located.line).toBe(3);
    expect(located.column).toBe(7);
    expect(located.module).toBe('app');
  });
});
