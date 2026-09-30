import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  SopRuleEngine,
  SopRegistry,
  SopLoader,
  evaluateRuleAccuracy,
  loadRuleGoldenDir,
  toRuleFindings,
  formatRuleAccuracyReport,
} from '@zh/kernel';
import { augmentProcessPath } from '@zh/shared';
import { SemgrepAdapter } from '../adapters';

/**
 * 规则质量门禁 — golden 断言回放（2026-09-22 建立）
 *
 * 要解决的问题：本项目 Gate 的判据是「单测全绿 + 条款打勾」，而单测天然是逐段 mock
 * 的孤岛，照不到「规则报得对不对」。已实证后果：`security.scan.semgrep.path-traversal`
 * 用模式匹配做本该由数据流分析完成的事（只匹配 path.join/resolve 的函数名），
 * 在真实仓库产出 358 条告警，其中绝大多数是合法代码（`os.homedir()` / `__dirname`
 * 这类纯本地拼接全被误报）。规则自带注释承认「上线前需在 CI 跑一次统计误报率」
 * —— 但**没有任何地方强制做这件事**。
 *
 * 本测试把这件事变成门禁：
 *   1. `fixtures/rule-golden/project` 植入正例（真污点流）+ 反例（易误报的合法代码）
 *   2. `fixtures/rule-golden/golden/*.json` 声明每条规则「应报 / 不应报」
 *   3. 真实执行规则后由 `evaluateRuleAccuracy` 算 precision/recall，未达标即红
 *
 * 新增规则**只需加一个 golden.json**，不需要写新测试代码。
 *
 * ⚠️ 依赖 semgrep（`~/.local/bin/semgrep`，不在默认 PATH）：本文件模块级补 PATH，
 * 工具缺失时显式跳过而非假绿。
 */

const PRESETS_DIR = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'kernel',
  'src',
  'sop',
  'presets',
  'sop-templates',
);
const FIXTURE_ROOT = path.resolve(__dirname, '..', '..', 'e2e', 'fixtures', 'rule-golden');
/** fixture 源（版本控制内，**仅作为拷贝源**，绝不直接扫描 —— 原因见 runtimeProjectDir 注释） */
const PROJECT_DIR = path.join(FIXTURE_ROOT, 'project');
const GOLDEN_DIR = path.join(FIXTURE_ROOT, 'golden');

/**
 * 运行期扫描根 —— **必须落在仓库外的临时目录**。
 *
 * 为什么不能直接扫 `e2e/fixtures/rule-golden/project`（2026-09-22 实测踩坑，血案）：
 * `fixtures` 是被被测链路**三重排除**的目录名 ——
 *   ① `SemgrepAdapter.accessScope.excludePaths` 含 fixtures 目录排除（glob）
 *   ② `SemgrepScanArgsBuilder` 追加 CLI 参数 `--exclude fixtures`
 *   ③ 规则资产自身 `paths.exclude` 含 fixtures 目录排除（glob）
 * 样本一旦落在 `fixtures/` 下 ⇒ semgrep 一个文件都不扫 ⇒ `violationCount=0` ⇒
 * 门禁稳定输出 `precision=1.000 / recall=0.000` 的**假绿**：
 * 真阳性样本被当成「规则漏报」，而真相是「样本压根没进扫描」。
 * 更毒的变体：反例（clean）同样没被扫，于是误报也不再暴露 —— 门禁看起来"严谨"却什么都没测。
 *
 * 拷到 `os.tmpdir()` 后一次性绕开全部仓库相对排除，且**更贴近真实场景**：
 * 用户项目不在本仓库内，天然不含这些排除项。门禁要测的是「规则对用户项目的判断力」，
 * 不是「规则对自己测试目录的判断力」。
 */
let tmpRoot = '';
let runtimeProjectDir = '';

const TARGET_RULE = 'security.scan.semgrep.path-traversal';

// 单测进程不自动补 PATH（产品链路由 CLI/desktop 启动时调），semgrep 在 ~/.local/bin
augmentProcessPath();

function hasSemgrep(): boolean {
  try {
    execFileSync('semgrep', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const SEMGREP_AVAILABLE = hasSemgrep();

/**
 * CI 强制模式：CI 里必须显式安装 semgrep 并把本变量置 1。
 *
 * 动机（形态 ⑩ 的变体）：本项目 CI 的历史做法是「工具不装，测试优雅降级跳过」
 * （见 `.github/workflows/ci.yml` 的注释「semgrep/trivy 不装」）。对普通单测这没问题，
 * 但**对门禁是致命的** —— 门禁一旦因工具缺失被 skip，就退化成「永远绿」，
 * 与它要防的「静默失效」是同一类病。
 * ⇒ 强制模式下工具缺失必须 **失败**，不允许 skip。
 */
const REQUIRE_SEMGREP = process.env.ZH_GATE_REQUIRE_SEMGREP === '1';

describe('规则质量门禁 — golden 断言回放', () => {
  beforeAll(() => {
    if (!SEMGREP_AVAILABLE) {
      console.warn('[规则质量门禁] 未找到 semgrep，跳过 gate（CI 必须安装工具，否则门禁形同虚设）');
    }
    // 把 fixture 副本拷到仓库外（tmpdir），绕开 fixtures/__tests__ 等 repo 相对排除
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zhshield-rule-gate-'));
    runtimeProjectDir = path.join(tmpRoot, 'proj');
    fs.cpSync(PROJECT_DIR, runtimeProjectDir, { recursive: true });
  });

  afterAll(() => {
    if (!tmpRoot) return;
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // 沙箱可能拦删除；tmpdir 会由系统回收，不因此让测试变红
    }
  });

  it('golden 数据可加载且格式合法', () => {
    const golden = loadRuleGoldenDir(GOLDEN_DIR);
    expect(golden.length).toBeGreaterThan(0);
    const target = golden.find((g) => g.ruleId === TARGET_RULE);
    expect(target, `golden 中应存在 ${TARGET_RULE}`).toBeDefined();
    expect(target!.assertions.length).toBeGreaterThan(0);
    // 必须同时含正例与反例 —— 只验正例的门禁抓不到误报
    expect(target!.assertions.some((a) => a.expect === 'violation')).toBe(true);
    expect(target!.assertions.some((a) => a.expect === 'clean')).toBe(true);
  });

  // ─── 环境自检：门禁不得以「工具缺失」为由静默降级（2026-09-23）───
  it('环境自检 · CI 强制模式下 semgrep 必须可用', () => {
    if (!REQUIRE_SEMGREP) return; // 本地未开强制开关时不做此检查，保持开发体验
    expect(
      SEMGREP_AVAILABLE,
      'CI 设置了 ZH_GATE_REQUIRE_SEMGREP=1，但未检测到 semgrep —— ' +
        '门禁不得以 skip 收场（形态⑩：静默降级＝假绿）',
    ).toBe(true);
  });

  // ─── 门禁自证：不能抓错的门禁等于没有门禁（2026-09-22）───
  // 背景：本文件刚经历过一次「假绿」—— fixture 落在被测规则自己的排除目录内，
  // 全链路零检出却稳定输出 precision=1.000，看起来"通过"实则什么都没测。
  // 故补两条负向断言，证明判据对「误报」与「漏报」两个方向都敏感。

  it('门禁自证 · 误报必须判红', () => {
    const golden = loadRuleGoldenDir(GOLDEN_DIR);
    // 模拟规则退化（如退回 pattern-match）：真阳性报出，但对合法代码 clean-local.ts 也误报
    const findings = toRuleFindings([
      { ruleId: TARGET_RULE, file: 'src/tainted.ts' },
      { ruleId: TARGET_RULE, file: 'src/clean-local.ts' },
    ]);
    const accuracy = evaluateRuleAccuracy(golden, findings);
    const ev = accuracy.evaluations.find((e) => e.ruleId === TARGET_RULE)!;
    expect(ev.falsePositives, '对 clean 样本的报出必须计为 FP').toBeGreaterThan(0);
    expect(accuracy.passesThresholds, '存在误报时门禁必须判红').toBe(false);
  });

  it('门禁自证 · 漏报必须判红', () => {
    const golden = loadRuleGoldenDir(GOLDEN_DIR);
    // 零输出 = 真阳性全漏（也可能是「样本被排除、压根没扫」，此判据正是用来暴露它的）
    const accuracy = evaluateRuleAccuracy(golden, []);
    const ev = accuracy.evaluations.find((e) => e.ruleId === TARGET_RULE)!;
    expect(ev.falseNegatives, '真阳性断言未被任何 finding 认领').toBeGreaterThan(0);
    expect(accuracy.passesThresholds, '漏报真阳性时门禁必须判红').toBe(false);
  });

  // 本地缺 semgrep ⇒ 跳过（保持开发体验）；CI 强制模式 ⇒ 不跳过，缺工具直接红
  it.skipIf(!SEMGREP_AVAILABLE && !REQUIRE_SEMGREP)(
    'path-traversal：真阳性被检出，且反向样本不误报（precision/recall 达标）',
    async () => {
      const golden = loadRuleGoldenDir(GOLDEN_DIR);

      const registry = new SopRegistry();
      await new SopLoader(registry, { rulesDir: PRESETS_DIR }).loadFromFileSystem();

      const engine = new SopRuleEngine(registry);
      engine.registerToolAdapter('semgrep', new SemgrepAdapter());

      // ⚠️ 扫的是仓库外的副本（runtimeProjectDir），不是 fixtures 原路径 —— 见其注释
      const report = await engine.evaluateRules({ repoRoot: runtimeProjectDir, domain: 'security' });

      const findings = toRuleFindings(
        report.evaluations.flatMap((e) => e.violations ?? []),
        runtimeProjectDir,
      );

      const accuracy = evaluateRuleAccuracy(golden, findings);
      if (!accuracy.passesThresholds) {
        console.error(formatRuleAccuracyReport(accuracy));
        // 门禁失败时必须能自证原因（规则被裁剪？工具报错？字段没透传？）
        const ev = report.evaluations.find((e) => e.rule.id === TARGET_RULE);
        console.error(
          '[诊断] target evaluation:',
          JSON.stringify({
            found: ev != null,
            status: ev?.status,
            message: ev?.message,
            violationCount: ev?.violations?.length,
            keys: ev ? Object.keys(ev) : null,
          }),
        );
        console.error(
          '[诊断] 全部规则状态:',
          report.evaluations.map((e) => `${e.rule.id}=${e.status}`).join(', '),
        );
        console.error('[诊断] findings:', JSON.stringify(findings.slice(0, 10)));
      }

      // ① 真阳性必须被检出（否则规则是静默空跑）
      const targetFindings = findings.filter((f) => f.ruleId === TARGET_RULE);
      expect(targetFindings.length, '真阳性样本 src/tainted.ts 必须被检出').toBeGreaterThan(0);

      // ② 反向样本不得被报（否则误报重现）
      const reportedFiles = new Set(targetFindings.map((f) => f.file.replace(/\\/g, '/')));
      expect(reportedFiles.has('src/clean-local.ts'), 'os.homedir/__dirname 拼接不得误报').toBe(
        false,
      );
      expect(reportedFiles.has('src/clean-literal.ts'), '字面量拼接不得误报').toBe(false);

      // ③ 门禁总闸
      expect(accuracy.passesThresholds).toBe(true);
    },
    240_000,
  );
});
