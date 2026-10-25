/**
 * unlink 的告警强度分级：**交付物**被删 vs **临时文件**被删。
 *
 * 真实事故（2026-10-25）：外层项目积压 18 条 p2 `File unlink`，标题分别是
 * `.probe.cjs` / `tmp-preview.tsx` / `verify-fix.mjs` / `.pnpm-lock.yaml.*.tmp` …
 * 全部是代理工具造的临时/探针文件。`git status` 里 ` D` 计数为 0 —— 没有任何
 * 交付物真的丢了，但用户看到的是 18 个 p2 问题。
 *
 * 因此本文件钉两条契约（缺一不可，只测一条会假绿）：
 * 1. 未跟踪的临时文件被删 → p3 信息类事件（`file-unlink-untracked`），不进默认告警；
 * 2. 被 git 跟踪的交付物被删 → 仍是 p2 告警（`file-unlink`），不许被消噪连带吞掉。
 *
 * 刻意用真实 `git init` + `git add`：判据本身来自 git 索引，注入假索引测不出
 * 「非 git 仓库 fail-open」与真实索引读取这两条路径。
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { FileMonitor, EventCenter, DEFAULT_IGNORE_DIRS, defaultFileWatchFilter } from '../index';
import type { SentinelEvent } from '../index';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 初始化一个真实 git 仓库；git 不可用时返回 false（CI 环境无 git 则跳过） */
function initRepo(root: string): boolean {
  try {
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const GIT_AVAILABLE = (() => {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'zh-git-probe-'));
  const ok = initRepo(probe);
  fs.rmSync(probe, { recursive: true, force: true });
  return ok;
})();

function unlinkEventsOf(center: EventCenter, filePath: string): SentinelEvent[] {
  return center.listEvents().filter(
    (e) => e.context?.changeType === 'unlink' && e.context?.filePath === filePath,
  );
}

describe.skipIf(!GIT_AVAILABLE)('unlink 告警强度按交付物分级', () => {
  it('未跟踪临时文件 → p3 信息类；被跟踪交付物 → p2 告警', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zh-fm-tracked-'));
    expect(initRepo(root)).toBe(true);
    const srcDir = path.join(root, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    const tracked = path.join(srcDir, 'keep.ts');
    const scratch = path.join(srcDir, '.probe.cjs');
    fs.writeFileSync(tracked, 'export const keep = 1;\n');
    fs.writeFileSync(scratch, 'console.log(1);\n');
    // 只把 keep.ts 放进索引；.probe.cjs 保持未跟踪（与事故现场一致）
    try {
      execFileSync('git', ['add', 'src/keep.ts'], { cwd: root, stdio: 'pipe' });
    } catch (err) {
      const e = err as { stderr?: Buffer; stdout?: Buffer };
      throw new Error(
        `git add 失败: ${String(e.stderr ?? '')}${String(e.stdout ?? '')} root=${root}`,
        { cause: err },
      );
    }

    const center = new EventCenter();
    const monitor = new FileMonitor(center);
    monitor.start({
      projectId: 'proj-tracked',
      watchPaths: [root],
      intervalMs: 40,
      ignoreDirs: DEFAULT_IGNORE_DIRS,
      filter: defaultFileWatchFilter,
    });
    try {
      await sleep(400); // 等首轮轮询把两个文件登记为「已知」
      fs.rmSync(tracked);
      fs.rmSync(scratch);
      await sleep(1500);

      const trackedEvents = unlinkEventsOf(center, tracked);
      const scratchEvents = unlinkEventsOf(center, scratch);

      // 真阳性：交付物被删仍然是 p2
      expect(trackedEvents).toHaveLength(1);
      expect(trackedEvents[0]!.severity).toBe('p2');
      expect(trackedEvents[0]!.history[0]?.action).toBe('file-unlink');

      // 降噪：临时文件被删降级为 p3 信息类
      expect(scratchEvents).toHaveLength(1);
      expect(scratchEvents[0]!.severity).toBe('p3');
      expect(scratchEvents[0]!.history[0]?.action).toBe('file-unlink-untracked');
      expect(scratchEvents[0]!.context?.tracked).toBe(false);
    } finally {
      monitor.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 20000);

  it('非 git 仓库（索引不可判定）→ 保持 p2，不许把真实删除吞成 p3', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zh-fm-nogit-'));
    const plain = path.join(root, 'loose.ts');
    fs.writeFileSync(plain, 'export const x = 1;\n');

    const center = new EventCenter();
    const monitor = new FileMonitor(center);
    monitor.start({
      projectId: 'proj-nogit',
      watchPaths: [root],
      intervalMs: 40,
      ignoreDirs: DEFAULT_IGNORE_DIRS,
      filter: defaultFileWatchFilter,
    });
    try {
      await sleep(400);
      fs.rmSync(plain);
      await sleep(1500);

      const events = unlinkEventsOf(center, plain);
      expect(events).toHaveLength(1);
      expect(events[0]!.severity).toBe('p2');
      expect(events[0]!.history[0]?.action).toBe('file-unlink');
      expect(events[0]!.context?.tracked).toBeNull();
    } finally {
      monitor.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 20000);
});
