import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileMonitor, EventCenter, resolveChangeType, DEFAULT_IGNORE_DIRS, DEFAULT_IGNORE_RE, defaultFileWatchFilter } from '../index';

describe('resolveChangeType fs.watch 事件类型归一化', () => {
  it('change 事件在文件存在时保持 change', () => {
    expect(resolveChangeType('change', true, true)).toBe('change');
  });

  it('macOS rename 且文件已存在且已知 → change', () => {
    expect(resolveChangeType('rename', true, true)).toBe('change');
  });

  it('macOS rename 且文件已存在但未知 → add（新建文件）', () => {
    expect(resolveChangeType('rename', true, false)).toBe('add');
  });

  it('rename/unlink 且文件不存在 → unlink', () => {
    expect(resolveChangeType('rename', false, true)).toBe('unlink');
    expect(resolveChangeType('unlink', false, true)).toBe('unlink');
  });

  it('显式 unlink 信号优先于磁盘状态', () => {
    expect(resolveChangeType('unlink', true, true)).toBe('unlink');
  });
});

describe('默认忽略规则（噪音路径）', () => {
  it('命中依赖/构建/测试/工具产物目录', () => {
    const noisy = [
      '/proj/node_modules/pkg/index.js',
      '/proj/zhiyan-codeshield/packages/desktop/dist-electron/main.js',
      '/proj/zhiyan-codeshield/packages/desktop/test-results/.last-run.json',
      '/proj/zhiyan-codeshield/packages/desktop/test-results/trace.zip',
      '/proj/zhiyan-codeshield/packages/desktop/test-results/error-context.md',
      '/proj/zhiyan-codeshield/packages/desktop/.playwright-artifacts-0/shot.png',
      '/proj/zhiyan-codeshield/packages/desktop/.playwright-artifacts-1/shot.png',
      '/proj/.playwright-mcp/state.json',
      '/proj/.omo/run-continuation/ses_025d64df2ffeZMTofO2r8LQ7D3.json',
      '/proj/.opencode/sessions/ses_029fa45dcffeF0ZYfgSMcVNSHM.json',
      '/proj/.zhshield/guard-reports.jsonl',
      '/proj/coverage/lcov.info',
    ];
    for (const p of noisy) {
      expect(DEFAULT_IGNORE_RE.test(p), p).toBe(true);
      expect(defaultFileWatchFilter(p), p).toBe(false);
    }
  });

  it('命中临时文件与 TypeScript 构建缓存（tsbuildinfo）', () => {
    const noisy = [
      '/proj/zhiyan-codeshield/_tmp_5769_8448c06a329974ee939ceea3be7872c3',
      '/proj/zhiyan-codeshield/_tmp_85458_0368b6118d93550beff3c092455163a8',
      '/proj/zhiyan-codeshield/packages/guard/tsconfig.tsbuildinfo',
      '/proj/zhiyan-codeshield/packages/pipeline/tsconfig.tsbuildinfo',
    ];
    for (const p of noisy) {
      expect(DEFAULT_IGNORE_RE.test(p), p).toBe(true);
      expect(defaultFileWatchFilter(p), p).toBe(false);
    }
  });

  it('命中编辑器锁文件与 macOS 元数据文件（Vim 交换/Emacs 锁/.DS_Store）', () => {
    const noisy = [
      '/proj/zhiyan-codeshield/.!31175!file-monitor.ts',
      '/proj/zhiyan-codeshield/.!31147!file-monitor.ts',
      '/proj/zhiyan-codeshield/.!31146!file-monitor.ts',
      '/proj/src/.#runner.ts',
      '/proj/src/runner.ts.swp',
      '/proj/src/runner.ts.swo',
      '/proj/.DS_Store',
    ];
    for (const p of noisy) {
      expect(DEFAULT_IGNORE_RE.test(p), p).toBe(true);
      expect(defaultFileWatchFilter(p), p).toBe(false);
    }
  });

  it('不命中真实源码路径', () => {
    const source = [
      '/proj/src/pages/GuardPage.tsx',
      '/proj/src/utils/copyToAi.ts',
      '/proj/src/pages/guard-logic.ts',
      '/proj/zhiyan-codeshield/packages/desktop/e2e/app.spec.ts',
    ];
    for (const p of source) {
      expect(DEFAULT_IGNORE_RE.test(p), p).toBe(false);
      expect(defaultFileWatchFilter(p), p).toBe(true);
    }
  });

  it('ignoreDirs 列表含全部关键噪音目录', () => {
    for (const dir of ['node_modules', '.git', 'dist', 'dist-electron', 'test-results', '.playwright-mcp', '.opencode', '.omo', '.zhshield', '.turbo']) {
      expect(DEFAULT_IGNORE_DIRS, dir).toContain(dir);
    }
  });
});

describe('FileMonitor 噪音过滤（端到端）', () => {
  const tmpDirs: string[] = [];

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zh-sentinel-'));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('node_modules/测试产物目录内的变更不产生事件，源码变更产生事件', async () => {
    const root = makeTmpDir();
    const eventCenter = new EventCenter();
    const monitor = new FileMonitor(eventCenter);
    monitor.start({
      projectId: 'proj-1',
      watchPaths: [root],
      intervalMs: 60_000,
      ignoreDirs: DEFAULT_IGNORE_DIRS,
      filter: defaultFileWatchFilter,
    });
    try {
      fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
      fs.mkdirSync(path.join(root, 'test-results'), { recursive: true });
      fs.writeFileSync(path.join(root, 'node_modules', 'dep.js'), 'x');
      fs.writeFileSync(path.join(root, 'test-results', '.last-run.json'), '{}');
      const realFile = path.join(root, 'src', 'app.ts');
      fs.mkdirSync(path.dirname(realFile), { recursive: true });
      fs.writeFileSync(realFile, 'console.log(1)');
      // 子目录自身元数据变化（如子项增删导致目录 mtime 更新）不应产生事件，
      // 复现 macOS fs.watch 递归对目录自身触发 change 的噪声（如 "File change: zhiyan-codeshield"）
      const dirOnly = path.join(root, 'dir-only');
      fs.mkdirSync(dirOnly);
      const past = new Date(Date.now() - 5000);
      fs.utimesSync(dirOnly, past, past);

      await new Promise((r) => setTimeout(r, 300));

      const events = eventCenter.listEvents();
      expect(events.some((e) => e.context?.filePath?.toString().includes('node_modules'))).toBe(false);
      expect(events.some((e) => e.context?.filePath?.toString().includes('test-results'))).toBe(false);
      expect(events.some((e) => e.context?.filePath === realFile)).toBe(true);
      expect(events.some((e) => e.context?.filePath === dirOnly)).toBe(false);
      const realEvent = events.find((e) => e.context?.filePath === realFile)!;
      expect(['add', 'change']).toContain(realEvent.context?.changeType);
      expect(realEvent.title).not.toContain('rename');
    } finally {
      monitor.stop();
    }
  });

  it('同一 mtime 的重复 fs.watch 事件被去重（原子保存只产生一个事件）', async () => {
    const root = makeTmpDir();
    const eventCenter = new EventCenter();
    const monitor = new FileMonitor(eventCenter);
    monitor.start({
      projectId: 'proj-2',
      watchPaths: [root],
      intervalMs: 60_000,
      ignoreDirs: DEFAULT_IGNORE_DIRS,
      filter: defaultFileWatchFilter,
    });
    try {
      const file = path.join(root, 'dup.ts');
      fs.writeFileSync(file, 'v1');
      await new Promise((r) => setTimeout(r, 300));
      const countFor = () => eventCenter.listEvents().filter((e) => e.context?.filePath === file).length;
      const before = countFor();
      // macOS 原子保存会对同一写入触发多次 rename 回调但 mtime 不变：
      // utimesSync 强制触发一次事件，mtime 与上次相同 → 不应产生新事件
      const mtime = fs.statSync(file).mtimeMs;
      fs.utimesSync(file, new Date(mtime / 1000), new Date(mtime / 1000));
      await new Promise((r) => setTimeout(r, 300));
      expect(countFor()).toBe(before);
      // 真实写入（mtime 前进）→ 产生一个新事件
      fs.writeFileSync(file, 'v2');
      await new Promise((r) => setTimeout(r, 300));
      expect(countFor()).toBe(before + 1);
    } finally {
      monitor.stop();
    }
  });

  it('目录删除不产生 unlink 事件，真实文件删除仍产生 unlink', async () => {
    const root = makeTmpDir();
    const eventCenter = new EventCenter();
    const monitor = new FileMonitor(eventCenter);
    monitor.start({
      projectId: 'proj-3',
      watchPaths: [root],
      intervalMs: 60_000,
      ignoreDirs: DEFAULT_IGNORE_DIRS,
      filter: defaultFileWatchFilter,
    });
    try {
      const sub = path.join(root, 'sub-dir');
      fs.mkdirSync(sub);
      await new Promise((r) => setTimeout(r, 300));
      // macOS fs.watch 对目录自身触发 rename：目录删除后 stat 为 null，此前未被当作文件跟踪 → 无事件
      fs.rmdirSync(sub);
      await new Promise((r) => setTimeout(r, 300));
      expect(eventCenter.listEvents().some((e) => e.context?.filePath === sub)).toBe(false);

      const file = path.join(root, 'gone.ts');
      fs.writeFileSync(file, 'x');
      await new Promise((r) => setTimeout(r, 300));
      fs.rmSync(file);
      await new Promise((r) => setTimeout(r, 300));
      const unlinkEvent = eventCenter.listEvents().find((e) => e.context?.filePath === file);
      expect(unlinkEvent?.context?.changeType).toBe('unlink');
    } finally {
      monitor.stop();
    }
  });
});
