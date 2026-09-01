import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventCenter } from '../event-center';
import { LogCollector } from '../log-collector';

function makeProjectDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'logcol-proj-'));
}

function writeSourcemapProject(projectDir: string): string {
  fs.mkdirSync(path.join(projectDir, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, 'src/modules/order'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, 'logs'), { recursive: true });

  fs.writeFileSync(path.join(projectDir, 'dist/server.js'), 'console.log("hi");\n');
  fs.writeFileSync(
    path.join(projectDir, 'dist/server.js.map'),
    JSON.stringify({
      version: 3,
      file: 'server.js',
      sources: ['src/modules/order/order.service.ts'],
      names: [],
      mappings: 'AAAA;AACA',
    }),
  );
  fs.writeFileSync(
    path.join(projectDir, 'src/modules/order/order.service.ts'),
    'export function getOrder() {}\nexport function calc() {}\n',
  );

  return path.join(projectDir, 'logs/app.log');
}

describe('LogCollector crash stack location', () => {
  it('mounts stack and sourcemap-located context on crash lines', () => {
    const projectDir = makeProjectDir();
    const logPath = writeSourcemapProject(projectDir);
    const frameFile = path.join(projectDir, 'dist/server.js');
    fs.writeFileSync(
      logPath,
      `uncaughtException: boom\n    at getOrder (${frameFile}:2:15)\n    at processTicksAndRejections (node:internal/process/task_queues:95:5)\n`,
    );

    const ec = new EventCenter();
    const collector = new LogCollector(ec);
    collector.start({
      projectId: 'p1',
      logPaths: [logPath],
      projectPath: projectDir,
      pollIntervalMs: 50,
    });

    const events = ec.listEvents();
    const crashEvent = events.find((e) => e.context.pattern === 'uncaught-exception');
    expect(crashEvent).toBeDefined();

    const ctx = crashEvent!.context as Record<string, unknown>;
    expect(ctx.stack).toContain('at getOrder');
    expect(ctx.stack).toContain('node:internal');

    const location = ctx.location as {
      module: string;
      file: string;
      line: number;
      snippet?: string;
    };
    expect(location.module).toBe('order');
    expect(location.file).toBe('src/modules/order/order.service.ts');
    expect(location.line).toBe(2);
    expect(location.snippet).toContain('export function calc');

    collector.stop();
  });

  it('does not collect stack or location for non-crash patterns', () => {
    const projectDir = makeProjectDir();
    const logPath = writeSourcemapProject(projectDir);
    fs.writeFileSync(logPath, 'WARN something smells off\n    at foo (/x/y.ts:1:2)\n');

    const ec = new EventCenter();
    const collector = new LogCollector(ec);
    collector.start({
      projectId: 'p1',
      logPaths: [logPath],
      projectPath: projectDir,
      pollIntervalMs: 50,
    });

    const events = ec.listEvents();
    const warningEvent = events.find((e) => e.context.pattern === 'warning');
    expect(warningEvent).toBeDefined();
    const ctx = warningEvent!.context as Record<string, unknown>;
    expect(ctx.stack).toBeUndefined();
    expect(ctx.location).toBeUndefined();

    collector.stop();
  });

  it('skips stack frame lines so each frame emits no separate event', () => {
    const projectDir = makeProjectDir();
    const logPath = writeSourcemapProject(projectDir);
    const frameFile = path.join(projectDir, 'dist/server.js');
    fs.writeFileSync(
      logPath,
      `uncaughtException: boom\n    at getOrder (${frameFile}:2:15)\n    at helper (${frameFile}:1:5)\n`,
    );

    const ec = new EventCenter();
    const collector = new LogCollector(ec);
    collector.start({
      projectId: 'p1',
      logPaths: [logPath],
      projectPath: projectDir,
      pollIntervalMs: 50,
    });

    const events = ec.listEvents();
    expect(events.length).toBe(1);
    expect(events[0].context.pattern).toBe('uncaught-exception');

    collector.stop();
  });
});
