import * as path from 'node:path';
import type {
  ToolAdapter,
  ToolMeta,
  ToolResult,
  ToolScanBatchRequest,
  ToolScanOptions,
  IssueCategory,
  AccessScope,
} from '@zh/shared';
import { resolveSourceScanTarget } from '@zh/shared';
import { isCommandAvailable } from './tool-available';
import { buildAccessScope, ToolCommandResolver } from './tool-runner';
import { resolveInjectedConfigPath } from './injected-config';
import { SemgrepScanArgsBuilder } from './semgrep-scan-args-builder';
import { SemgrepScanRunner } from './semgrep-scan-runner';
import { isSemgrepRuleArray, removeInlineRuleFile, type SemgrepRule } from './semgrep-rule-writer';

const META: ToolMeta = {
  id: 'semgrep',
  name: 'Semgrep',
  category: 'inspect',
  priority: 'P0',
  installMode: 'builtin',
  description: 'SAST 代码漏洞扫描（SQL 注入、XSS、CSRF、命令注入、路径遍历等）',
  cliCommand: 'semgrep',
  homepage: 'https://semgrep.dev',
  license: 'LGPL-2.1',
};

/** runScanWithCleanup 的参数对象：扫描选项、命令行参数、类别、起始时间与内联规则临时文件 */
interface RunScanWithCleanupParams {
  options: ToolScanOptions;
  args: string[];
  category: IssueCategory;
  start: number;
  ruleFile: string | null;
}

export class SemgrepAdapter implements ToolAdapter {
  meta = META;
  private readonly commands: ToolCommandResolver;
  /** 单飞可用性结果：所有 semgrep 规则共享同一 adapter 实例，只探测一次 */
  private availabilityPromise?: Promise<boolean>;

  /** F5：semgrep 对源码做 SAST 规则匹配 */
  readonly accessScope: AccessScope = buildAccessScope(
    ['**/*.{ts,tsx,js,jsx,py,go,java,rb,php,c,cpp,h}'],
    [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.semgrep/**',
      // 测试夹具：刻意构造的恶意样例（如 conflict-resolver/evil.ts）用于驱动规则测试，不是生产代码（对齐 refactor 引擎约定）
      '**/__tests__/**',
      '**/__fixtures__/**',
      '**/fixtures/**',
      '**/__mocks__/**',
    ],
  );

  private readonly argsBuilder = new SemgrepScanArgsBuilder();
  private readonly runner = new SemgrepScanRunner();

  constructor(projectRoot?: string) {
    this.commands = new ToolCommandResolver('semgrep', projectRoot);
  }

  async isAvailable(): Promise<boolean> {
    // 单飞：resolveToolCommand 内部 PATH 探测已跑一次 `--version`（Python 冷启动实测 16.7s），
    // isCommandAvailable 再跑一次。多条 semgrep 规则并发 isAvailable 时会有 2N 次并发
    // 冷启动，全部撞 20s 超时 → 误判未安装。缓存到首个探测 Promise，其余规则等同一结果。
    if (!this.availabilityPromise) {
      this.availabilityPromise = isCommandAvailable(() => this.commands.resolve(), 60000);
    }
    return this.availabilityPromise;
  }

  async scan(options: ToolScanOptions): Promise<ToolResult> {
    const start = Date.now();
    const { targetDir, category, configs, declaredConfigs, rules } = this.resolveScanSetup(options);

    const unavailable = this.checkConfigAvailability(declaredConfigs, configs, rules);
    if (unavailable) return this.runner.buildUnavailable(start, unavailable);

    const { args, ruleFile } = await this.argsBuilder.build(options, configs, targetDir);
    const command = await this.resolveCommandForScan(options);
    return this.runScanWithCleanup(command, { options, args, category, start, ruleFile });
  }

  /**
   * A12 批量派发：把 N 条"各自带内联规则"的扫描请求合并成**一次** semgrep 进程。
   *
   * 为什么要合并：SOP 巡检里每条 semgrep 规则都会写一份自己的临时 `--config`，
   * argv 天然不同，运行作用域去重（runToolOnce）看不见它们 —— 实测一轮安全域
   * `semgrep scan ×11`，几乎全是规则解析与启动开销。合并后 ≥11 → 1。
   *
   * 合并的安全边界（不满足就**不合并**，退回逐条 scan，行为与今天完全一致）：
   *   · 每条请求都必须有内联 rules、且没有路径 config（路径 config 的解析/回退语义
   *     各请求可能不同，合并会把 A 的失败连累到 B）；
   *   · 全部请求的 projectPath / targetDir / category 必须一致（目标不同的扫描合并
   *     会让 A 命中 B 的代码）；
   *   · 少于 2 条不合并（没有收益）。
   *
   * 归属：每条请求的规则 id 加前缀 `zhbN--` 后写进同一份配置；结果按前缀分回各自
   * 请求，并把 check_id 还原成原始 id，保证映射/fingerprint 与逐条扫描逐字段等价。
   */
  async scanBatch(requests: ToolScanBatchRequest[]): Promise<Map<string, ToolResult>> {
    const merged = new Map<string, ToolResult>();
    const usable: Array<{
      key: string;
      options: ToolScanOptions;
      setup: ReturnType<SemgrepAdapter['resolveScanSetup']>;
    }> = [];
    for (const request of requests) {
      const setup = this.resolveScanSetup(request.options);
      const hasInline = (setup.rules?.length ?? 0) > 0;
      const hasPathConfig = setup.configs.length > 0 || setup.declaredConfigs.length > 0;
      if (!hasInline || hasPathConfig) continue;
      usable.push({ key: request.key, options: request.options, setup });
    }
    const first = usable[0];
    if (!first || usable.length < 2) return merged;

    const firstProject = path.resolve(first.options.projectPath);
    const sameTarget = usable.every(
      (u) =>
        path.resolve(u.options.projectPath) === firstProject &&
        u.setup.targetDir === first.setup.targetDir &&
        u.setup.category === first.setup.category,
    );
    if (!sameTarget) return merged;

    // 前缀只用 semgrep id 允许的字符：[a-zA-Z0-9._-]
    const prefixOf = (index: number): string => `zhb${index}--`;
    const ownerOfId = new Map<string, { key: string; checkId: string }>();
    const combined: SemgrepRule[] = [];
    usable.forEach((entry, index) => {
      for (const rule of entry.setup.rules ?? []) {
        const originalId = rule.id ?? `rule-${combined.length}`;
        const prefixedId = `${prefixOf(index)}${originalId}`;
        combined.push({ ...rule, id: prefixedId });
        ownerOfId.set(prefixedId, { key: entry.key, checkId: originalId });
      }
    });

    const ruleFile = await this.argsBuilder.writeRulesFile(combined);
    if (!ruleFile) return merged;

    try {
      const command = await this.resolveCommandForScan(first.options);
      const args = this.argsBuilder.buildForRuleFile(ruleFile, first.setup.targetDir);
      return await this.runner.runPartitioned({
        command,
        options: first.options,
        args,
        category: first.setup.category,
        start: Date.now(),
        keys: usable.map((u) => u.key),
        keyOf: (result) => {
          const raw = result.check_id ?? result.rule?.id;
          if (!raw) return null;
          // semgrep 会把 --config 的文件路径当前缀编进 check_id：
          // `<路径>.zhb2--sql-injection-concat-literal`（2026-11-03 实测，
          // 只做全等匹配会让所有命中都"认不出归属"→ 全被判干净，是安全工具最危险的假阴性）。
          // 因此按"末段"取回我们自己的前缀 id。
          const match = /(?:^|\.)(zhb\d+--[A-Za-z0-9._-]+)$/.exec(raw);
          if (!match) return null;
          return ownerOfId.get(match[1]) ?? null;
        },
      });
    } finally {
      await removeInlineRuleFile(ruleFile);
    }
  }

  /** 锚定 projectPath，不受 cwd 影响（09-12 复验修复）：以扫描目标锚定本地 bin 解析 */
  private async resolveCommandForScan(options: ToolScanOptions): Promise<string> {
    return this.commands.resolve(options.projectPath);
  }

  /** 执行 semgrep 扫描，结束后（含抛错）清理内联规则临时文件 */
  private async runScanWithCleanup(
    command: string,
    params: RunScanWithCleanupParams,
  ): Promise<ToolResult> {
    const { options, args, category, start, ruleFile } = params;
    try {
      return await this.runner.run({ command, options, args, category, start });
    } finally {
      // 内联规则写在系统临时目录：扫描一结束（含抛错）就清掉，避免临时文件堆积
      await removeInlineRuleFile(ruleFile);
    }
  }

  /** 解析扫描目标、类别与规则配置 */
  private resolveScanSetup(options: ToolScanOptions): {
    targetDir: string;
    category: IssueCategory;
    configs: string[];
    declaredConfigs: string[];
    rules: SemgrepRule[] | undefined;
  } {
    // 归一化 projectPath 为绝对路径：相对路径会流入 --config/--target 参数，
    // semgrep 以自身 cwd 解析导致 "unable to find a config; path ... does not exist"。
    const projectPath = path.resolve(options.projectPath);
    const targetDir = options.targetFiles?.[0] ?? this.resolveTargetDir(projectPath);
    const category: IssueCategory = options.config?.category ?? 'security';
    const declaredConfigs = this.resolveConfigs(options);
    // 按回退链（项目根 → @zh/kernel 包内路径）解析为存在的绝对路径，缺失项剔除
    const configs = declaredConfigs
      .map((c) => resolveInjectedConfigPath(c, projectPath, projectPath))
      .filter((p): p is string => p !== null);
    const rules = isSemgrepRuleArray(options.config?.rules) ? options.config.rules : undefined;
    return { targetDir, category, configs, declaredConfigs, rules };
  }

  /** 校验 config / 内联 rules 可用性，缺失时返回 unavailable 原因 */
  private checkConfigAvailability(
    declaredConfigs: string[],
    configs: string[],
    rules: SemgrepRule[] | undefined,
  ): string | null {
    const hasInlineRules = rules != null && rules.length > 0;

    // 注入的 config 多为规则声明的仓库内部相对路径（node_modules/@zh/kernel/dist/assets/...），
    // 已按回退链解析；全部无法解析且无内联 rules 时退化为 unavailable（映射为 skipped），而非硬错误。
    // 存在内联 rules 时以内联规则执行（config 缺失不阻断）：registry 风格 config
    // （如 typescript/lang/security/）无法本地解析，但规则自带 pattern 时扫描仍可进行。
    if (configs.length === 0 && !hasInlineRules) {
      if (declaredConfigs.length > 0) {
        return `Semgrep 配置不存在，跳过该规则: ${declaredConfigs.join(', ')}`;
      }
      // 既无显式 config 也无内联 rules 时禁止裸跑 semgrep scan：不带 --config 会回退到
      // semgrep 官方 registry auto 规则集（英文通用规则，如 detect-non-literal-regexp 等），
      // 产生与受控规则语义不一致的误报（典型：guard.security-scan 的 scanners 派发
      // toolConfig 为空导致 9+ 个误报阻断）。未配置规则集即视为检测不可用（映射为 skipped）。
      return 'Semgrep 未配置规则集（无 config 或无内联 rules），跳过扫描';
    }

    return null;
  }

  /** 目标目录解析：src → packages → 项目根；容器根项目下探嵌套代码仓库的 packages 目录，避免全量扫描 */
  private resolveTargetDir(projectPath: string): string {
    // 统一走 @zh/shared 的 resolveSourceScanTarget —— security 侧的 semgrep 适配器
    // 曾因另写一份而直接用项目根当目标（慢 4 倍），两侧共用一份即杜绝此类分叉。
    return resolveSourceScanTarget(projectPath);
  }

  private resolveConfigs(options: ToolScanOptions): string[] {
    const cfgs = options.config?.config;
    if (!cfgs) return [];
    if (Array.isArray(cfgs)) return cfgs as string[];
    if (typeof cfgs === 'string') return [cfgs];
    return [];
  }
}
