import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { compareSopTrees, describeSopSyncProblems } from '../../scripts/sop-sync-compare.mjs';

/**
 * 规则资产「源码 ↔ 发布产物」同步门禁（2026-10-25 建立）
 *
 * 为什么需要它在 pnpm test 里，而不只是 CI：
 *   `packages/cli/dist/sop` 是**入库的发布产物**（Action 门禁直接取它），
 *   `build-cli.mjs` 构建时才从 `kernel/src/sop` 重生成。改规则 YAML 却只跑单包测试、
 *   忘了重建 CLI，就会提交一份陈旧产物 —— 用户与 CI 拿到的是旧规则，
 *   而本地一切绿灯。2026-10-24 的 `execution` 段清理就差点这样发出去。
 *
 * 为什么它比原来的 CI 步骤更有效：
 *   原 CI 把 `verify:sop` 排在 `Build` 之后，而 Build 会 rm -rf + cp -r 重建 dist/sop
 *   ⇒ 校验的是"刚重新生成的产物"，结构上不可能红。本用例跑在测试阶段，
 *   比较的是**签入仓库的那份**，才是真正要守的东西。
 *
 * 本用例自带两道自证（任缺其一都可能是假绿）：
 *   ① 样本自证：绿的同时打印比较了多少文件，样本不足即失败；
 *   ② 判据自证：拿真实产物拷一份、改一个字节，必须报漂移。
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const SOP_SRC = path.join(REPO_ROOT, 'packages', 'kernel', 'src', 'sop');
const SOP_DST = path.join(REPO_ROOT, 'packages', 'cli', 'dist', 'sop');

/** 真实产物作为"必须存在"的样本依据；不存在说明仓库布局变了，本门禁即失效 */
const PROBE_REL = path.join('presets', 'sop-templates', 'garbage', 'scan', 'cleanup', 'dead-code.yml');

const tmpDirs: string[] = [];

function makeTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  // 沙箱环境可能拒绝 unlink/rmdir；清理失败不影响结论，故忽略异常
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe('规则资产 dist/sop 同步门禁', () => {
  it('签入的 dist/sop 与 kernel/src/sop 完全一致（样本自证）', () => {
    const result = compareSopTrees(SOP_SRC, SOP_DST);

    // 样本自证：不打印数量就判"通过"，无法区分"真同步"和"两边都没读到"
    console.log(
      `[sop-dist-sync] 比较 ${result.checked} 个文件；漂移 ${result.differing.length} / ` +
        `缺失 ${result.missing.length} / 多余 ${result.extra.length}`,
    );
    expect(result.checked).toBeGreaterThanOrEqual(90);

    const problems = describeSopSyncProblems(result);
    expect(problems).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('判据会红：真实产物改一个字节后必须报漂移，且定位到该文件', () => {
    const copy = path.join(makeTmp('sop-sync-real-'), 'dist-sop');
    fs.cpSync(SOP_DST, copy, { recursive: true });

    const victim = path.join(copy, PROBE_REL);
    // 先确认探针文件真的在样本里：不存在则这条断言本身是假绿
    expect(fs.existsSync(victim)).toBe(true);
    fs.appendFileSync(victim, '\n# drift-probe 2026-10-25\n');

    const result = compareSopTrees(SOP_SRC, copy);
    expect(result.ok).toBe(false);
    expect(result.differing).toContain(PROBE_REL.replace(/\\/g, path.sep));
  });

  it('清单漂移：产物侧缺失与多余文件都要被检出', () => {
    const root = makeTmp('sop-sync-list-');
    const src = path.join(root, 'src');
    const dst = path.join(root, 'dst');
    fs.mkdirSync(src, { recursive: true });
    fs.mkdirSync(dst, { recursive: true });
    fs.writeFileSync(path.join(src, 'a.yml'), 'id: a\n');
    fs.writeFileSync(path.join(src, 'b.yml'), 'id: b\n');
    fs.writeFileSync(path.join(dst, 'a.yml'), 'id: a\n');
    fs.writeFileSync(path.join(dst, 'c.yml'), 'id: c\n');

    const result = compareSopTrees(src, dst);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['b.yml']);
    expect(result.extra).toEqual(['c.yml']);
    expect(result.differing).toEqual([]);
  });

  it('目录缺失或为空一律判失败（禁止"读不到就当没问题"）', () => {
    const root = makeTmp('sop-sync-miss-');
    const emptyDir = path.join(root, 'empty');
    fs.mkdirSync(emptyDir, { recursive: true });
    const absent = path.join(root, 'does-not-exist');

    const noDst = compareSopTrees(emptyDir, absent);
    expect(noDst.ok).toBe(false);
    expect(noDst.problems.length).toBeGreaterThan(0);

    const noSrc = compareSopTrees(absent, emptyDir);
    expect(noSrc.ok).toBe(false);
    expect(noSrc.problems.length).toBeGreaterThan(0);

    const bothEmpty = compareSopTrees(emptyDir, emptyDir);
    expect(bothEmpty.ok).toBe(false);
    expect(bothEmpty.problems.length).toBeGreaterThan(0);
  });

  /**
   * 守门禁的门禁：CI 里本校验必须排在 Build 之前。
   * Build 会 rm -rf 并从源码重建 dist/sop，一旦顺序反过来，校验对象就变成
   * "刚重新生成的产物"，永远绿 —— 2026-10-25 之前 CI 正是这样失效的。
   * 用行定位而非解析 YAML：本包无 js-yaml 依赖，且这里只需要顺序这一条信息。
   */
  it('CI 中 verify:sop 必须排在 Build 之前（防止门禁被构建过程重置）', () => {
    const ciFile = path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml');
    expect(fs.existsSync(ciFile)).toBe(true);
    const lines = fs.readFileSync(ciFile, 'utf8').split('\n');

    const verifyAt = lines.findIndex((l) => /^\s*-\s*name:\s*Verify dist\/sop sync/.test(l));
    const buildAt = lines.findIndex((l) => /^\s*-\s*name:\s*Build \(exclude/.test(l));

    // 找不到步骤 ⇒ 本断言失效，必须红（改名/删除都要有人来更新这里）
    expect({ verifyAt: verifyAt >= 0, buildAt: buildAt >= 0 }).toEqual({
      verifyAt: true,
      buildAt: true,
    });
    expect(verifyAt).toBeLessThan(buildAt);
  });
});
