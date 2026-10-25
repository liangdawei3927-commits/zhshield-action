/**
 * 整包删除（Electron .app 重建）回归测试
 *
 * 真实事故（2026-10-25）：哨兵对 `/Users/dawei/Desktop/ZHCodeShield` 报出 270 条
 * p2 事件，全部形如「File unlink: locale.pak」。根因不是文件真的丢了，而是
 * electron-builder 重建 `build-output/mac/智汇码盾.app` 时先删旧包再写新包，
 * 而 macOS 递归 fs.watch 对整树删除会**逐文件**上报 —— 一个 338 文件的应用包
 * 必然炸出几百条事件，且标题只取 basename，220 个 `locale.pak` 长得一模一样。
 *
 * 本文件锁住两条契约：
 * 1. 整树删除折叠成一条（真阳性：事故中应只报 1 条，不是 270 条）；
 * 2. 单个文件删除仍然照常上报（不能为了消噪把真实信号也消掉）。
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileMonitor, EventCenter, DEFAULT_IGNORE_DIRS, defaultFileWatchFilter } from '../index';
import type { SentinelEvent } from '../index';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zh-fm-bundle-'));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 造一个形如 <root>/<relParent>/<name> 的小号目录树：20 个同名 locale.pak + 若干散文件 */
function makeTree(root: string, relParent: string, name: string): string {
  const tree = path.join(root, relParent, name, 'Contents');
  fs.mkdirSync(path.join(tree, 'MacOS'), { recursive: true });
  fs.mkdirSync(path.join(tree, 'Resources'), { recursive: true });
  fs.writeFileSync(path.join(tree, 'MacOS', 'main'), 'bin');
  fs.writeFileSync(path.join(tree, 'Resources', 'icon.icns'), 'icns');
  fs.writeFileSync(path.join(tree, 'Info.plist'), 'plist');
  for (let i = 0; i < 20; i += 1) {
    const lproj = path.join(tree, 'Resources', `lang${i}.lproj`);
    fs.mkdirSync(lproj, { recursive: true });
    fs.writeFileSync(path.join(lproj, 'locale.pak'), 'pak');
  }
  return path.join(root, relParent, name);
}

function unlinkEvents(center: EventCenter): SentinelEvent[] {
  return center.listEvents().filter((e) => e.context?.changeType === 'unlink');
}

/**
 * 启动监控 → 等待轮询把整包登记为「已知」→ 删除整包。
 * 文件必须在删除前被轮询登记过（lastMtimes 有记录），否则 wasKnown=false 本就不会报。
 */
async function monitorThenRemove(
  root: string,
  remove: () => void,
): Promise<{ center: EventCenter; monitor: FileMonitor }> {
  const center = new EventCenter();
  const monitor = new FileMonitor(center);
  monitor.start({
    projectId: 'proj-bundle',
    watchPaths: [root],
    intervalMs: 40,
    ignoreDirs: DEFAULT_IGNORE_DIRS,
    filter: defaultFileWatchFilter,
  });
  // 等首轮轮询把文件登记进 lastMtimes（40ms 一次，400ms 内足够多轮）
  await sleep(400);
  remove();
  await sleep(1500);
  return { center, monitor };
}

describe('整树删除不产生事件风暴', () => {
  it('删除含 20 个同名 locale.pak 的整棵树 → 只报 1 条，且标题可定位到目录', async () => {
    const root = makeTmpDir();
    const tree = makeTree(root, 'src', 'bundle');
    const { center, monitor } = await monitorThenRemove(root, () => {
      fs.rmSync(tree, { recursive: true, force: true });
    });
    try {
      const events = unlinkEvents(center);
      // 事故态：23 个文件逐个上报 → 23 条；修复目标：折叠成 1 条
      expect(
        events,
        `实际报出 ${events.length} 条：${events.map((e) => e.title).join(' / ')}`,
      ).toHaveLength(1);
      const only = events[0]!;
      expect(only.severity).toBe('p2');
      // 标题必须能定位到目录，不能是光秃秃的 basename
      expect(only.title).toContain('bundle');
      expect(only.context?.collapsedCount).toBeGreaterThan(1);
    } finally {
      monitor.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('*.app 应用包整包删除 → 0 条（二进制产物不进哨兵视野）', async () => {
    const root = makeTmpDir();
    const app = makeTree(root, 'mac', 'App.app');
    const { center, monitor } = await monitorThenRemove(root, () => {
      fs.rmSync(app, { recursive: true, force: true });
    });
    try {
      expect(
        unlinkEvents(center),
        `应用包应被忽略，实际报出 ${unlinkEvents(center).length} 条`,
      ).toHaveLength(0);
    } finally {
      monitor.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('build-output 下的整包删除 → 0 条（构建产物不纳入哨兵视野）', async () => {
    const root = makeTmpDir();
    // 刻意用非 .app 的普通目录名：单独验证「构建产物目录」这条防线，
    // 否则会被 .app 规则兜住，测不出 build-output 这条是否真的生效。
    const app = makeTree(root, 'build-output', 'payload');
    const { center, monitor } = await monitorThenRemove(root, () => {
      fs.rmSync(app, { recursive: true, force: true });
    });
    try {
      expect(
        unlinkEvents(center),
        `构建产物目录应被忽略，实际报出 ${unlinkEvents(center).length} 条`,
      ).toHaveLength(0);
    } finally {
      monitor.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('单个文件删除仍然照常上报 p2 unlink（不误杀真实信号）', async () => {
    const root = makeTmpDir();
    const target = path.join(root, 'src', 'app.ts');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'v1');
    const { center, monitor } = await monitorThenRemove(root, () => {
      fs.rmSync(target);
    });
    try {
      const events = unlinkEvents(center);
      expect(events).toHaveLength(1);
      expect(events[0]?.severity).toBe('p2');
      expect(events[0]?.context?.collapsedCount).toBeUndefined();
    } finally {
      monitor.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
