import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ContentInterpreter } from '../runner';
import { SopRegistry } from '../sop/_meta/sop-registry';
import { SopLoader } from '../sop/_meta/sop-loader';
import type { SopRule } from '../sop/_meta/sop-types';

/**
 * cli 发布产物（cli/dist/sop）的「可加载 + 可解释」守卫（2026-10-25 建立）
 *
 * 为什么需要这条：`pnpm --filter zhshield-cli verify:sop` 只做**字节比对**
 * （dist/sop 与 kernel/src/sop 逐文件 hash），它能证明"两份拷贝一样"，
 * 却完全看不见"内核加载器能不能把这份拷贝读成规则"。技能文档原话：
 * hash 一致但加载 0 条是可能的。而 CLI 启动时 `resolveBundledSopDir()` 指的
 * 正是这个 dist 目录 —— 一旦它加载为 0，引擎进入盲检、所有检查默认通过。
 *
 * 实测口径（2026-10-25，内核 dist + 本文件的两份资产）：
 *   dist(cli 发布产物) 加载 43 / 活跃 29 / unresolved 0
 *   src (内核源码)     加载 43 / 活跃 29 / unresolved 0
 *
 * 故本文件锁三件事，且**不写死条数**（避免数字过期）：
 *   ① dist 能被同一个内核加载器读出非 0 条规则；
 *   ② dist 与源码的规则 id 集合、活跃条数逐项一致（缺文件/域目录漏拷必红）；
 *   ③ dist 里每条 active 规则都解释为可执行指令，不落 unresolved 兜底。
 * 另配三段自证，证明上述判据**真的会红**（不是恒绿的门禁）。
 */
const DIST_SOP_DIR = path.resolve(__dirname, '../../../cli/dist/sop/presets/sop-templates');
const SRC_SOP_DIR = path.resolve(__dirname, '../sop/presets/sop-templates');

/** 用与产品完全相同的加载器读一个规则目录 */
async function loadDir(dir: string): Promise<{
  loaded: number;
  all: SopRule[];
  active: SopRule[];
}> {
  const registry = new SopRegistry();
  const loader = new SopLoader(registry, { rulesDir: dir });
  const loaded = await loader.loadFromFileSystem();
  return { loaded, all: registry.getAll(), active: registry.getActive() };
}

/** 只有 metadata、没有任何执行指令的坏规则：解释器无从解释，必落 unresolved */
const ORPHAN_RULE = `apiVersion: sop/v1
kind: InspectRule
metadata:
  id: "inspect.scan.test.orphan"
  name: "坏样本（无 check 段）"
  version: "0.0.0"
  status: "active"
  source: "internal"
governance:
  domain: "inspect"
  action: "scan"
`;

function makeTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function tryRemove(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // 沙箱可能拦 unlink；临时目录残留不影响判定，不让清理失败伪装成用例失败
  }
}

describe('cli 发布产物 sop 目录 — 可加载守卫', () => {
  it('发布产物能被内核加载器读出规则（"hash 一致但加载 0 条"是本用例要拦的）', async () => {
    expect(
      fs.existsSync(DIST_SOP_DIR),
      `缺少发布产物目录 ${DIST_SOP_DIR}。packages/cli/dist/sop 受 git 跟踪，缺失即发布链路断裂，不可跳过`,
    ).toBe(true);

    const { loaded, all, active } = await loadDir(DIST_SOP_DIR);

    // 绿的时候也要看得见查了多少条，否则"读空"与"真加载"在输出上无从分辨
    console.log(
      `[sop-dist-artifact] dist 加载 ${loaded} 条 / 全部 ${all.length} 条 / 活跃 ${active.length} 条`,
    );

    expect(loaded).toBeGreaterThan(0);
    expect(active.length).toBeGreaterThan(0);
  });

  it('dist 与内核源码的规则 id 集合、活跃条数逐项一致', async () => {
    const dist = await loadDir(DIST_SOP_DIR);
    const src = await loadDir(SRC_SOP_DIR);

    // 两侧同时读空时 id 集合会"相等"——先排除这个假绿
    expect(src.loaded, '内核源码 presets 应能加载出规则（否则比较本身失效）').toBeGreaterThan(0);

    const idsOf = (rules: SopRule[]): string[] => rules.map((r) => r.id).sort();
    expect(idsOf(dist.all)).toEqual(idsOf(src.all));
    expect(dist.active.length).toBe(src.active.length);
  });

  it('dist 中每条 active 规则都解释为可执行指令（不落 unresolved 兜底）', async () => {
    const { active } = await loadDir(DIST_SOP_DIR);
    expect(active.length).toBeGreaterThan(0);

    const interpreter = new ContentInterpreter();
    const unresolved = active
      .map((rule) => ({ id: rule.id, instr: interpreter.interpret(rule) }))
      .filter(({ instr }) => instr.type === 'unresolved')
      .map(({ id, instr }) => (instr.type === 'unresolved' ? `${id} → ${instr.reason}` : id));

    expect(unresolved).toEqual([]);
  });
});

describe('cli 发布产物 sop 目录 — 判据自证（证明上面的断言会红）', () => {
  it('空目录 → 加载 0 条，故"加载非 0"的断言必红', async () => {
    const empty = makeTmpDir('zhshield-sop-empty-proof-');
    try {
      const { loaded, active } = await loadDir(empty);
      expect(loaded).toBe(0);
      expect(active.length).toBe(0);
    } finally {
      tryRemove(empty);
    }
  });

  it('缺执行指令的规则 → 必落 unresolved，故"不落兜底"的断言必红', async () => {
    const root = makeTmpDir('zhshield-sop-orphan-proof-');
    const ruleDir = path.join(root, 'inspect', 'scan');
    try {
      fs.mkdirSync(ruleDir, { recursive: true });
      fs.writeFileSync(path.join(ruleDir, 'orphan.yml'), ORPHAN_RULE, 'utf8');

      const { loaded, active } = await loadDir(root);
      expect(loaded).toBe(1);
      expect(active.length).toBe(1);
      expect(new ContentInterpreter().interpret(active[0]).type).toBe('unresolved');

      // 同时证明"id 集合一致"那条对差异敏感：坏样本目录 ≠ 空目录
      const empty = makeTmpDir('zhshield-sop-empty-cmp-');
      try {
        const emptyLoaded = await loadDir(empty);
        expect(loaded === emptyLoaded.all.length).toBe(false);
      } finally {
        tryRemove(empty);
      }
    } finally {
      tryRemove(root);
    }
  });
});
