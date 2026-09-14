import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';

// 复查4 P0 端到端验收门禁：降级护栏不得只挂在 --sop 开关后面。
// 此前缺陷：隔离环境（无任何外部工具）下 `zhshield inspect`（默认，无 --sop）
// 8 项检查全跳过仍「100 分 / A / 流水线通过 / exit 0」——因为 degraded 判定
// 被包在 cli/index.ts 的 if (opts.sop) 内。修复后默认路径同样 degraded>0 → exit 2。
//
// 本用例直接驱动 git 跟踪的发布产物 packages/cli/dist/zhshield.js：
// 这是有意为之——dist 产物与源码是两份东西（产物三份论），源码修复未重建
// 产物时本用例必须红，倒逼重建。CI（ci.yml）先 turbo build 再 test，可满足。

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const BUNDLE = path.join(REPO_ROOT, 'packages', 'cli', 'dist', 'zhshield.js');
const SAMPLE_REPO = path.join(REPO_ROOT, 'scripts', 'fixtures', 'sample-repo');
const NODE = process.execPath;

const bundleExists = fs.existsSync(BUNDLE);

describe.runIf(bundleExists)('CLI 端到端 — 默认路径降级护栏（复查4 P0）', () => {
  it('Given 隔离 HOME/PATH（所有外部工具不可用），When 不带 --sop 跑 inspect，Then exit 2 且输出降级警告', () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zhshield-fakehome-'));
    try {
      const res = spawnSync(NODE, [BUNDLE, 'inspect', '--dir', SAMPLE_REPO], {
        // PATH 剥离到最小集：gitleaks/semgrep/depcruise/tsc 全部不可见，
        // 复现"什么都没实际查"的降级场景（等价于复查4 的决定性对照实验 B）
        env: { ...process.env, HOME: fakeHome, PATH: '/usr/bin:/bin' },
        encoding: 'utf-8',
        timeout: 120_000,
      });
      expect(res.status, `stdout=${res.stdout}\nstderr=${res.stderr}`).toBe(2);
      expect(res.stderr).toContain('降级警告');
      expect(res.stderr).toContain('未检测 ≠ 通过');
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  }, 150_000);
});
