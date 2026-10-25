/**
 * 交付物索引（git-index）单测——重点钉一条**假阴性**回归：
 *
 * 监控根（外层文档仓库）与被监控文件所属仓库（内层代码仓库）**不是同一个仓库**。
 * 若索引锚点取监控根，内层仓库里所有已跟踪源文件都会查不到 ⇒ 被判「未跟踪」
 * ⇒ 真实删除被降级成 p3 信息类事件并从告警列表消失。
 *
 * 这组用例全部建真实 git 仓库（临时目录），不 mock git —— 判据本身就是 git 语义，
 * mock 掉就等于没测。
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findRepoRootFor, GitIndexCache } from '../git-index';

const roots: string[] = [];

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function write(file: string, content = 'x\n'): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/**
 * 造出与真实仓库同构的现场：
 *   outer/            ← 监控根（外层仓库），.gitignore 忽略 inner/
 *     AGENTS.md       ← 外层已跟踪
 *     inner/          ← 内层独立仓库
 *       .git/
 *       packages/app/src/keep.ts   ← 内层已跟踪
 *       packages/app/scripts/.probe.cjs ← 内层未跟踪
 */
function makeNestedRepos(): {
  outer: string;
  inner: string;
  outerTracked: string;
  innerTracked: string;
  innerUntracked: string;
} {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'zh-gitidx-'));
  roots.push(outer);
  git(outer, 'init', '-q');
  write(path.join(outer, '.gitignore'), 'inner/\n');
  write(path.join(outer, 'AGENTS.md'));
  git(outer, 'add', '.gitignore', 'AGENTS.md');

  const inner = path.join(outer, 'inner');
  fs.mkdirSync(inner, { recursive: true });
  git(inner, 'init', '-q');
  const innerTracked = path.join(inner, 'packages/app/src/keep.ts');
  write(innerTracked);
  git(inner, 'add', 'packages/app/src/keep.ts');
  const innerUntracked = path.join(inner, 'packages/app/scripts/.probe.cjs');
  write(innerUntracked);

  return {
    outer,
    inner,
    outerTracked: path.join(outer, 'AGENTS.md'),
    innerTracked,
    innerUntracked,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('仓库根解析：锚点是「目标最近的仓库」，不是监控根', () => {
  it('内层文件解析到内层仓库根，外层文件解析到外层仓库根', () => {
    const f = makeNestedRepos();
    // 与 findRepoRootFor 同口径比较：它返回 path.resolve 形态（不解析 /var → /private/var 软链）
    expect(findRepoRootFor(path.dirname(f.innerTracked))).toBe(path.resolve(f.inner));
    expect(findRepoRootFor(path.dirname(f.outerTracked))).toBe(path.resolve(f.outer));
  });

  it('不在任何仓库里 → null（调用方按不可判定处理，不下结论）', async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'zh-gitidx-plain-'));
    roots.push(plain);
    write(path.join(plain, 'a.ts'));
    expect(findRepoRootFor(plain)).toBeNull();
    const cache = new GitIndexCache();
    expect(await cache.isTracked(path.join(plain, 'a.ts'))).toBeNull();
  });
});

describe('isTracked：跨仓库边界的交付物判定', () => {
  it('【回归】内层已跟踪源文件 → true（曾因锚点取监控根而误判未跟踪）', async () => {
    const f = makeNestedRepos();
    const cache = new GitIndexCache();
    expect(await cache.isTracked(f.innerTracked)).toBe(true);
  });

  it('内层未跟踪的临时/探针文件 → false（这正是 18 条误报的形态）', async () => {
    const f = makeNestedRepos();
    const cache = new GitIndexCache();
    expect(await cache.isTracked(f.innerUntracked)).toBe(false);
  });

  it('外层已跟踪文档 → true（原有行为不回退）', async () => {
    const f = makeNestedRepos();
    const cache = new GitIndexCache();
    expect(await cache.isTracked(f.outerTracked)).toBe(true);
  });

  it('同步判定与异步判定结论一致（启动期收敛与热路径必须同口径）', () => {
    const f = makeNestedRepos();
    const cache = new GitIndexCache();
    expect(cache.isTrackedSync(f.innerTracked)).toBe(true);
    expect(cache.isTrackedSync(f.innerUntracked)).toBe(false);
  });

  it('目录形态：目录不在索引、其下有跟踪文件 → true（整树删除仍需告警）', async () => {
    const f = makeNestedRepos();
    const cache = new GitIndexCache();
    const dir = path.join(f.inner, 'packages/app/src');
    expect(await cache.isTracked(dir)).toBe(true);
  });

  it('整树删除后（目录已不存在）仍能解析到仓库并判定', async () => {
    const f = makeNestedRepos();
    fs.rmSync(path.join(f.inner, 'packages/app/src'), { recursive: true, force: true });
    const cache = new GitIndexCache();
    expect(await cache.isTracked(path.join(f.inner, 'packages/app/src'))).toBe(true);
  });
});
