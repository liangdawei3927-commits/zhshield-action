import { describe, expect, it, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ComplexityDetectorImpl } from '../adapters/complexity-detector';
import type { PerformanceIssue } from '../types';

const CJK_RE = /[\u4e00-\u9fff]/;
const detector = new ComplexityDetectorImpl();

const dirs: string[] = [];
function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function writeFile(dir: string, name: string, content: string): void {
  const filePath = path.join(dir, name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

/** 建临时项目：files 的 key 是相对项目根的路径（通常落在 src/ 下） */
function project(name: string, files: Record<string, string>): string {
  const dir = tmpDir(`zh-perf-${name}-`);
  for (const [rel, content] of Object.entries(files)) writeFile(dir, rel, content);
  return dir;
}

function scan(name: string, files: Record<string, string>): PerformanceIssue[] {
  return detector.detect(project(name, files));
}

const loopsOf = (issues: PerformanceIssue[]): PerformanceIssue[] =>
  issues.filter((i) => i.ruleId === 'complexity.nested-loop');
const syncOf = (issues: PerformanceIssue[]): PerformanceIssue[] =>
  issues.filter((i) => i.ruleId === 'complexity.sync-io');

/** 浏览器构建里 fs 由 <script> 注入的 shim 提供，故无 node 内建导入 */
const BROWSER_SHIM = 'declare function readFileSync(p: string, e: string): string;';

afterEach(() => {
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
});

describe('complexity-detector · nested-loop', () => {
  it('三层嵌套 for 循环 → nested-loop (medium)', () => {
    const issues = scan('nested-loop', {
      'src/services/heavy.ts': [
        'export function heavyAggregate(input: number[]): number {',
        '  let acc = 0;',
        '  for (let i = 0; i < input.length; i++) {',
        '    for (let j = 0; j < input.length; j++) {',
        '      for (let k = 0; k < input.length; k++) {',
        '        acc += input[i] * input[j] - input[k];',
        '      }',
        '    }',
        '  }',
        '  return acc;',
        '}',
      ].join('\n'),
    });

    const hit = loopsOf(issues)[0];
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe('medium');
    expect(hit?.category).toBe('complexity');
    expect(hit?.file).toBe('src/services/heavy.ts');
    expect(hit?.message).toContain('3 层嵌套循环');
    expect(hit?.message).toMatch(CJK_RE);
    expect(hit?.autoFixable).toBe(false);
  });

  it('报告真实深度、最内层被遍历表达式与最外层循环行号，且不再断言时间复杂度', () => {
    const issues = scan('loop-report', {
      'src/index-ast.ts': [
        'export function index(deps: Map<string, string[]>) {',
        '  for (const [, versions] of deps) {',
        '    for (const raw of versions) {',
        '      for (const chunk of raw.split("\\n")) {',
        '        for (const ch of chunk) {',
        '          console.log(ch);',
        '        }',
        '      }',
        '    }',
        '  }',
        '}',
      ].join('\n'),
    });

    const hit = loopsOf(issues)[0];
    expect(hit?.message).toContain('4 层嵌套循环');
    // 报的是**最内层**那一环的遍历源（第 4 层 for 的 chunk），不是中间任一层
    expect(hit?.message).toContain('最内层遍历 chunk');
    expect(hit?.message).not.toContain('O(n^');
    expect(hit?.line).toBe(2);
  });

  it('for...of 三层嵌套被检出（最内层取 iterable 表达式）', () => {
    const issues = scan('loop-forof', {
      'src/forof.ts': [
        'export function walk(deps: Map<string, Set<string>>) {',
        '  for (const [, versions] of deps) {',
        '    for (const version of versions) {',
        '      for (const file of version.split(",")) {',
        '        console.log(file);',
        '      }',
        '    }',
        '  }',
        '}',
      ].join('\n'),
    });

    const hit = loopsOf(issues)[0];
    expect(hit?.message).toContain('3 层嵌套循环');
    expect(hit?.message).toContain('version.split(",")');
  });

  it('for...in 三层嵌套被检出（最内层取 iterable 表达式）', () => {
    const issues = scan('loop-forin', {
      'src/forin.ts': [
        'export function walk(node: { children: Record<string, unknown>; leaves: string[] }) {',
        '  for (const key in node.children) {',
        '    for (const nested in node.children) {',
        '      for (const leaf of node.leaves) {',
        '        console.log(key, nested, leaf);',
        '      }',
        '    }',
        '  }',
        '}',
      ].join('\n'),
    });

    const hit = loopsOf(issues)[0];
    expect(hit?.message).toContain('3 层嵌套循环');
    expect(hit?.message).toContain('node.leaves');
    expect(hit?.line).toBe(2);
  });

  it('无 condition 的 for(;;) 参与计数且不崩溃', () => {
    const issues = scan('loop-forever', {
      'src/forever.ts': [
        'export function spin(items: string[]) {',
        '  for (;;) {',
        '    for (const a of items) {',
        '      for (const b of items) {',
        '        console.log(a, b);',
        '      }',
        '    }',
        '    break;',
        '  }',
        '}',
      ].join('\n'),
    });

    expect(loopsOf(issues)).toHaveLength(1);
    expect(loopsOf(issues)[0]?.message).toContain('3 层嵌套循环');
  });

  it('无花括号循环体不再抬高层数（不把下一个函数体的 { 误记为循环体）', () => {
    const issues = scan('loop-braceless', {
      'src/origin.ts': [
        'const evidence: string[] = [];',
        'function addEvidence(file: string, entry: string): void {',
        '  for (const e of evidence) addEvidence(file, e);',
        '}',
        'export function pairUp(rows: string[], cols: string[]) {',
        '  for (const r of rows) {',
        '    for (const c of cols) {',
        '      console.log(r, c);',
        '    }',
        '  }',
        '}',
      ].join('\n'),
    });

    expect(loopsOf(issues)).toHaveLength(0);
  });

  it('同文件多条同深循环链只报一条，并取最靠前那条链的最外层行号', () => {
    const issues = scan('loop-tie', {
      'src/tie.ts': [
        'export function first(items: string[]) {',
        '  for (const a of items) {',
        '    for (const b of items) {',
        '      for (const c of items) {',
        '        console.log(a, b, c);',
        '      }',
        '    }',
        '  }',
        '}',
        'export function second(items: string[]) {',
        '  for (const a of items) {',
        '    for (const b of items) {',
        '      for (const c of items) {',
        '        console.log(a, b, c);',
        '      }',
        '    }',
        '  }',
        '}',
      ].join('\n'),
    });

    const hits = loopsOf(issues);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.line).toBe(2);
  });

  it('.tsx 源码（JSX 语法）也能被解析并统计循环层数', () => {
    const issues = scan('loop-tsx', {
      'src/Table.tsx': [
        'export function renderTable(rows: string[][], cols: string[]): JSX.Element {',
        '  const out: string[] = [];',
        '  for (const row of rows) {',
        '    for (const col of cols) {',
        '      for (const cell of row) {',
        '        out.push(`${col}=${cell}`);',
        '      }',
        '    }',
        '  }',
        '  return (',
        '    <table><tbody><tr>{out.join(",")}</tr></tbody></table>',
        '  );',
        '}',
      ].join('\n'),
    });

    expect(loopsOf(issues)).toHaveLength(1);
  });

  it('两层嵌套循环不触发 nested-loop', () => {
    const issues = scan('2loop', {
      'src/two.ts': [
        'export function twoLoop(data: number[]) {',
        '  for (let i = 0; i < data.length; i++) {',
        '    for (let j = 0; j < data.length; j++) {',
        '      console.log(data[i] + data[j]);',
        '    }',
        '  }',
        '}',
      ].join('\n'),
    });

    expect(loopsOf(issues)).toHaveLength(0);
  });

  it('while 和 do-while 三层嵌套也触发 nested-loop', () => {
    const issues = scan('while', {
      'src/while.ts': [
        'export function whileNested(data: number[]) {',
        '  let i = 0;',
        '  while (i < data.length) {',
        '    let j = 0;',
        '    do {',
        '      let k = 0;',
        '      while (k < data.length) {',
        '        console.log(data[i] + data[j] + data[k]);',
        '        k++;',
        '      }',
        '      j++;',
        '    } while (j < data.length);',
        '    i++;',
        '  }',
        '}',
      ].join('\n'),
    });

    const hit = loopsOf(issues)[0];
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe('medium');
  });

  it('clean file with simple code → no issues', () => {
    const issues = scan('clean', {
      'src/app.ts': [
        'export function greet(name: string): string {',
        '  return `Hello, ${name}!`;',
        '}',
      ].join('\n'),
    });

    expect(issues).toHaveLength(0);
  });

  it('non-existent src dir → empty array, no throw', () => {
    const dir = tmpDir('zh-perf-nosrc-');
    expect(() => detector.detect(dir)).not.toThrow();
    expect(detector.detect(dir)).toEqual([]);
  });

  it('注释中的 readFileSync 不触发 sync-io', () => {
    const issues = scan('comment', {
      'src/commented.ts': [
        '// fs.readFileSync("secret.txt", "utf8");',
        'export function safe(): string {',
        '  return "no sync IO";',
        '}',
      ].join('\n'),
    });

    expect(issues).toHaveLength(0);
  });

  it('问题对象形状完整', () => {
    const issues = scan('shape', {
      'src/bad.ts': [
        'export function deep(data: number[]) {',
        '  for (let i = 0; i < data.length; i++) {',
        '    for (let j = 0; j < data.length; j++) {',
        '      for (let k = 0; k < data.length; k++) {',
        '        console.log(data[i] + data[j] + data[k]);',
        '      }',
        '    }',
        '  }',
        '}',
      ].join('\n'),
    });

    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(typeof issue.id).toBe('string');
      expect(typeof issue.ruleId).toBe('string');
      expect(issue.category).toBe('complexity');
      expect(['medium', 'high']).toContain(issue.severity);
      expect(typeof issue.file).toBe('string');
      expect(typeof issue.message).toBe('string');
      expect(issue.message).toMatch(CJK_RE);
      expect(typeof issue.suggestion).toBe('string');
      expect(issue.autoFixable).toBe(false);
    }
  });
});

describe('complexity-detector · sync-io 运行时上下文', () => {
  it('Node 普通函数里的同步 IO → 不报（CLI/批处理上下文无并发可阻塞）', () => {
    const issues = scan('node-fn', {
      'src/utils/legacy.ts': [
        "import * as fs from 'fs';",
        'export function readConfig() {',
        '  return fs.readFileSync("/etc/config.json", "utf8");',
        '}',
        'export function writeResult(data: string) {',
        '  fs.writeFileSync("/tmp/output.txt", data);',
        '}',
      ].join('\n'),
    });

    expect(syncOf(issues)).toHaveLength(0);
  });

  it('Node 构造函数里的同步 IO → 不报（单例只初始化一次，不在每请求路径上）', () => {
    const issues = scan('node-ctor', {
      'src/auth/local-only.guard.ts': [
        "import { CanActivate, Injectable, ExecutionContext } from '@nestjs/common';",
        "import * as fs from 'node:fs';",
        "import * as path from 'node:path';",
        '',
        'function resolveLocalToken(): string {',
        '  const file = path.join("/tmp", ".api-token");',
        '  if (fs.existsSync(file)) return fs.readFileSync(file, "utf-8").trim();',
        '  fs.writeFileSync(file, "generated-once", { mode: 0o600 });',
        '  return "generated-once";',
        '}',
        '',
        '@Injectable()',
        'export class LocalOnlyGuard implements CanActivate {',
        '  private readonly expectedToken: string;',
        '',
        '  constructor() {',
        '    this.expectedToken = resolveLocalToken();',
        '  }',
        '',
        '  canActivate(context: ExecutionContext): boolean {',
        '    return context.getType() !== "ws" && this.expectedToken.length > 0;',
        '  }',
        '}',
      ].join('\n'),
    });

    expect(syncOf(issues)).toHaveLength(0);
  });

  it('Node 类字段初始化里的同步 IO → 不报（随对象构造各执行一次）', () => {
    const issues = scan('node-field', {
      'src/store.ts': [
        "import { readFileSync } from 'node:fs';",
        'export class Store {',
        '  private readonly seed = readFileSync("/seed.json", "utf-8");',
        '  use(): string {',
        '    return this.seed;',
        '  }',
        '}',
      ].join('\n'),
    });

    expect(syncOf(issues)).toHaveLength(0);
  });

  it('Node 模块顶层的同步 IO → 不报（随模块求值执行一次）', () => {
    const issues = scan('node-toplevel', {
      'src/bootstrap.ts': [
        "import { execSync } from 'node:child_process';",
        'const rev = execSync("git rev-parse HEAD").toString();',
        'export const HEAD = rev.trim();',
      ].join('\n'),
    });

    expect(syncOf(issues)).toHaveLength(0);
  });

  it('Node 内建模块的各种导入形式（node: / 子路径 / require / 动态 import）→ 仍不报', () => {
    const issues = scan('node-imports', {
      'src/loader.ts': [
        "import { readFile } from 'fs/promises';",
        'const spec = "node:fs";',
        'export async function load(): Promise<unknown> {',
        '  const lazy = await import("node:fs");',
        '  const mod = require(spec);',
        '  return [await readFile("/a", "utf-8"), typeof lazy, typeof mod];',
        '}',
        'export function loadSync(): string {',
        '  return require("fs").readFileSync("/b", "utf-8");',
        '}',
      ].join('\n'),
    });

    expect(syncOf(issues)).toHaveLength(0);
  });

  it('用了 node 内建模块的文件即便有 DOM 全局也不算浏览器上下文 → 不报', () => {
    const issues = scan('node-with-dom', {
      'src/hydrate.ts': [
        "import { readFileSync } from 'node:fs';",
        'export function hydrate(): string {',
        '  const raw = readFileSync("/data.json", "utf-8");',
        '  document.body.dataset.state = "ready";',
        '  return raw;',
        '}',
      ].join('\n'),
    });

    expect(syncOf(issues)).toHaveLength(0);
  });

  it('浏览器上下文（无 node 内建 + DOM 全局）里的同步 IO → high，页面话术', () => {
    const issues = scan('browser', {
      'src/render-config.ts': [
        `// ${BROWSER_SHIM}`,
        'export function renderConfig(): string {',
        '  const raw = readFileSync("/config.json", "utf-8");',
        '  document.getElementById("cfg")!.textContent = raw;',
        '  return raw;',
        '}',
      ].join('\n'),
    });

    const hits = syncOf(issues);
    expect(hits).toHaveLength(1);
    const hit = hits[0];
    expect(hit?.id).toBe('complexity-sync-io-src/render-config.ts-readFileSync');
    expect(hit?.severity).toBe('high');
    expect(hit?.category).toBe('complexity');
    expect(hit?.file).toBe('src/render-config.ts');
    expect(hit?.line).toBe(3);
    expect(hit?.message).toContain('页面响应');
    expect(hit?.suggestion).toContain('Worker');
  });

  it('浏览器上下文的函数表达式与模块顶层同步 IO → high', () => {
    const issues = scan('browser-expr', {
      'src/titles.js': [
        `// ${BROWSER_SHIM}`,
        'document.title = readFileSync("/title.txt", "utf-8");',
        'export const loadTitle = function () {',
        '  return readFileSync("/title-2.txt", "utf-8");',
        '};',
      ].join('\n'),
    });

    // 两个调用点同属 readFileSync → 按 api 名去重为一条，定位到首个调用点
    const hits = syncOf(issues);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.line).toBe(2);
  });

  it('Electron 渲染进程（ipcRenderer）里的同步 IO → high，渲染话术', () => {
    const issues = scan('electron-renderer', {
      'src/settings.ts': [
        "import { ipcRenderer } from 'electron';",
        "import { readFileSync } from 'node:fs';",
        'export function loadSettings(): string {',
        '  ipcRenderer.send("settings:request");',
        '  return readFileSync("/settings.json", "utf-8");',
        '}',
      ].join('\n'),
    });

    const hit = syncOf(issues)[0];
    expect(hit?.severity).toBe('high');
    expect(hit?.message).toContain('渲染进程');
    expect(hit?.suggestion).not.toContain('Worker');
  });

  it('Electron 渲染进程（仅凭 DOM 全局判定）里的同步 IO → high', () => {
    const issues = scan('electron-renderer-dom', {
      'src/paint.ts': [
        "import { app } from 'electron';",
        "import { readFileSync } from 'node:fs';",
        'export function paint(): void {',
        '  const title = readFileSync("/tmp/title.txt", "utf-8");',
        '  window.document.title = title;',
        '}',
      ].join('\n'),
    });

    const hit = syncOf(issues)[0];
    expect(hit?.severity).toBe('high');
    expect(hit?.message).toContain('渲染进程');
  });

  it('Electron 主进程循环内的同步 IO → high，事件循环话术', () => {
    const issues = scan('electron-main-loop', {
      'src/preload.ts': [
        "import { app } from 'electron';",
        "import { readFileSync } from 'node:fs';",
        'export function preloadCaches(paths: string[]): void {',
        '  for (const p of paths) {',
        '    app.setPath(p, readFileSync(p, "utf-8"));',
        '  }',
        '}',
      ].join('\n'),
    });

    const hit = syncOf(issues)[0];
    expect(hit?.severity).toBe('high');
    expect(hit?.message).toContain('主进程');
    expect(hit?.message).toContain('窗口无响应');
  });

  it('Electron 主进程 ipcMain.handle / ipcMain.on 注册的监听器里的同步 IO → high', () => {
    const issues = scan('electron-main-ipc', {
      'src/ipc.ts': [
        "import { ipcMain } from 'electron';",
        "import { readFileSync } from 'node:fs';",
        'export function registerIpc(): void {',
        '  ipcMain.handle("project:read", (_event, name: string) =>',
        '    readFileSync(`/projects/${name}.json`, "utf-8"),',
        '  );',
        '  ipcMain.on("project:touch", (_event, name: string) => {',
        '    readFileSync(`/projects/${name}.json`, "utf-8");',
        '  });',
        '}',
      ].join('\n'),
    });

    // 同一文件同一 api 去重为一条；首个调用点在 ipcMain.handle 监听器内
    const hits = syncOf(issues);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.severity).toBe('high');
    expect(hits[0]?.line).toBe(5);
  });

  it('Electron 主进程启动期（非循环、非 IPC handler）里的同步 IO → 不报', () => {
    const issues = scan('electron-main-oneshot', {
      'src/boot.ts': [
        "import { app, BrowserWindow } from 'electron';",
        "import { readFileSync } from 'node:fs';",
        'export function readBuildInfo(): string {',
        '  return readFileSync("/build/info.json", "utf-8");',
        '}',
        'export function boot(): void {',
        '  void BrowserWindow;',
        '  void app;',
        '  readBuildInfo();',
        '}',
      ].join('\n'),
    });

    expect(syncOf(issues)).toHaveLength(0);
  });

  it('Electron 主进程里非 ipcMain 注册的其他回调里的同步 IO → 不报', () => {
    const issues = scan('electron-main-other-cb', {
      'src/emit.ts': [
        "import { ipcMain } from 'electron';",
        "import { readFileSync } from 'node:fs';",
        'function dump(label: string): void {',
        '  readFileSync(`/tmp/${label}.log`, "utf-8");',
        '}',
        'function plain(_fn: () => void): void { /* noop */ }',
        'const emitter = { on: (_n: string, _fn: () => void): void => undefined };',
        'export function register(): void {',
        '  ipcMain.emit("custom:event", () => dump("a"));',
        '  emitter.on("custom", () => dump("b"));',
        '  plain(() => dump("c"));',
        '}',
      ].join('\n'),
    });

    expect(syncOf(issues)).toHaveLength(0);
  });

  it('NestJS 守卫请求方法里的同步 IO → high，事件循环话术', () => {
    const issues = scan('nest-guard', {
      'src/audit.guard.ts': [
        "import { CanActivate, ExecutionContext } from '@nestjs/common';",
        "import * as fs from 'node:fs';",
        'export class AuditGuard implements CanActivate {',
        '  canActivate(context: ExecutionContext): boolean {',
        '    const raw = fs.readFileSync("/var/log/audit.log", "utf-8");',
        '    return raw.length > 0 && context.getType() !== "ws";',
        '  }',
        '}',
      ].join('\n'),
    });

    const hit = syncOf(issues)[0];
    expect(hit?.severity).toBe('high');
    expect(hit?.message).toContain('请求路径');
    expect(hit?.message).toContain('事件循环');
    expect(hit?.message).not.toContain('页面响应');
    expect(hit?.suggestion).not.toContain('Worker');
    expect(hit?.suggestion).toContain('fs/promises');
  });

  it('NestJS 控制器 @Get 装饰的方法里的同步 IO → high', () => {
    const issues = scan('nest-controller', {
      'src/projects.controller.ts': [
        "import { Controller, Get } from '@nestjs/common';",
        "import { readFileSync } from 'node:fs';",
        '@Controller("projects")',
        'export class ProjectsController {',
        '  @Get(":id")',
        '  findOne(): string {',
        '    return readFileSync("/data/projects.json", "utf-8");',
        '  }',
        '}',
      ].join('\n'),
    });

    expect(syncOf(issues)).toHaveLength(1);
    expect(syncOf(issues)[0]?.severity).toBe('high');
  });

  it('Express 风格 (req, res) 处理器里的同步 IO → high', () => {
    const issues = scan('express', {
      'src/projects.route.ts': [
        "import { readFileSync } from 'node:fs';",
        "import type { Request, Response } from 'express';",
        'abstract class BaseRoute {',
        '  abstract handle(req: Request, res: Response): void;',
        '}',
        'export class ProjectsRoute extends BaseRoute {',
        '  @Override',
        '  handle(req: Request, res: Response): void {',
        '    res.end(readFileSync(String(req.query.file), "utf-8"));',
        '  }',
        '}',
      ].join('\n'),
    });

    const hit = syncOf(issues)[0];
    expect(hit?.severity).toBe('high');
    expect(hit?.line).toBe(9);
  });

  it('只有一个形参且无请求装饰器的 Node 函数 → 不按 Express 处理器处理', () => {
    const issues = scan('node-one-param', {
      'src/one-param.ts': [
        "import { readFileSync } from 'node:fs';",
        'export function dump(req: string): string {',
        '  return readFileSync(req, "utf-8");',
        '}',
      ].join('\n'),
    });

    expect(syncOf(issues)).toHaveLength(0);
  });

  it('类表达式的 getter/setter 在浏览器上下文里的同步 IO → high', () => {
    const issues = scan('browser-accessors', {
      'src/store.ts': [
        `// ${BROWSER_SHIM}`,
        'declare function writeFileSync(p: string, d: string): void;',
        'export const Store = class {',
        '  private cached = "";',
        '  get value(): string {',
        '    return readFileSync(this.cached, "utf-8");',
        '  }',
        '  set value(next: string) {',
        '    this.cached = next;',
        '    writeFileSync(next, "x");',
        '  }',
        '};',
        'document.title = "store";',
      ].join('\n'),
    });

    const hits = syncOf(issues);
    expect(hits).toHaveLength(2);
    expect(hits.every((h) => h.severity === 'high')).toBe(true);
  });

  it('monorepo 布局（packages/*/src）里的浏览器上下文同步 IO → high', () => {
    const issues = scan('monorepo-browser', {
      'package.json': '{"name":"x","version":"1.0.0"}',
      'packages/web/src/boot.ts': [
        `// ${BROWSER_SHIM}`,
        'export function boot(): string {',
        '  const raw = readFileSync("/boot.json", "utf-8");',
        '  document.body.textContent = raw;',
        '  return raw;',
        '}',
      ].join('\n'),
    });

    const hits = syncOf(issues);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.file).toBe('packages/web/src/boot.ts');
  });
});
