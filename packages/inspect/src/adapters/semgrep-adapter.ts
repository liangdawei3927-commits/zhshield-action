import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  ToolAdapter,
  ToolMeta,
  ToolResult,
  ToolScanOptions,
  IssueCategory,
  AccessScope,
} from '@zh/shared';
import { resolveToolCommand } from './tool-bin';
import { isCommandAvailable } from './tool-available';
import { resolveInjectedConfigPath } from './injected-config';
import { SemgrepScanArgsBuilder } from './semgrep-scan-args-builder';
import { SemgrepScanRunner } from './semgrep-scan-runner';

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

/** 内联规则声明（来自 config.rules，原始声明为 string[]，此处按对象结构访问） */
interface SemgrepRule {
  id?: string;
  severity?: string;
  language?: string;
  languages?: string[];
  pattern?: string;
  /** pattern-either：多个候选 pattern，任一匹配即命中（如 const/let 赋值、直接内联拼接等变体） */
  patternEither?: string[];
  /** pattern-not：排除项，匹配则不算命中（如纯字符串字面量参数的无害调用） */
  patternNot?: string[];
  /** pattern-regex：正则匹配（generic 语言场景，如 CORS 配置串） */
  patternRegex?: string;
  message?: string;
  /** semgrep 元变量约束（metavariable-regex）：按绑定文本收紧 pattern，避免元变量匹配任意表达式造成误报 */
  metavariableRegex?: Array<{ metavariable: string; regex: string }>;
}

export class SemgrepAdapter implements ToolAdapter {
  meta = META;
  private commandPromise?: Promise<string>;
  /** 单飞可用性结果：所有 semgrep 规则共享同一 adapter 实例，只探测一次 */
  private availabilityPromise?: Promise<boolean>;
  private readonly projectRoot?: string;

  /** F5：semgrep 对源码做 SAST 规则匹配 */
  readonly accessScope: AccessScope = {
    readPaths: ['**/*.{ts,tsx,js,jsx,py,go,java,rb,php,c,cpp,h}'],
    excludePaths: [
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
  };

  private readonly argsBuilder = new SemgrepScanArgsBuilder();
  private readonly runner = new SemgrepScanRunner();

  constructor(projectRoot?: string) {
    this.projectRoot = projectRoot;
  }

  private resolveCommand(): Promise<string> {
    if (!this.commandPromise) {
      this.commandPromise = resolveToolCommand('semgrep', this.projectRoot);
    }
    return this.commandPromise;
  }

  async isAvailable(): Promise<boolean> {
    // 单飞：resolveToolCommand 内部 PATH 探测已跑一次 `--version`（Python 冷启动实测 16.7s），
    // isCommandAvailable 再跑一次。多条 semgrep 规则并发 isAvailable 时会有 2N 次并发
    // 冷启动，全部撞 20s 超时 → 误判未安装。缓存到首个探测 Promise，其余规则等同一结果。
    if (!this.availabilityPromise) {
      this.availabilityPromise = isCommandAvailable(() => this.resolveCommand(), 60000);
    }
    return this.availabilityPromise;
  }

  async scan(options: ToolScanOptions): Promise<ToolResult> {
    const start = Date.now();
    const { targetDir, category, configs, declaredConfigs, rules } = this.resolveScanSetup(options);

    const unavailable = this.checkConfigAvailability(declaredConfigs, configs, rules);
    if (unavailable) return this.runner.buildUnavailable(start, unavailable);

    const args = await this.argsBuilder.build(options, configs, targetDir);
    const command = await this.resolveCommand();
    return this.runner.run(command, options, args, category, start);
  }

  /** 解析扫描目标、类别与规则配置 */
  private resolveScanSetup(options: ToolScanOptions): {
    targetDir: string;
    category: IssueCategory;
    configs: string[];
    declaredConfigs: string[];
    rules: SemgrepRule[] | undefined;
  } {
    const targetDir = options.targetFiles?.[0] ?? this.resolveTargetDir(options.projectPath);
    const category: IssueCategory = options.config?.category ?? 'security';
    const declaredConfigs = this.resolveConfigs(options);
    // 按回退链（项目根 → @zh/kernel 包内路径）解析为存在的绝对路径，缺失项剔除
    const configs = declaredConfigs
      .map((c) => resolveInjectedConfigPath(c, options.projectPath, options.projectPath))
      .filter((p): p is string => p !== null);
    const rules = options.config?.rules as unknown as SemgrepRule[] | undefined;
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
    const srcDir = path.join(projectPath, 'src');
    if (fs.existsSync(srcDir)) return srcDir;
    const packagesDir = path.join(projectPath, 'packages');
    if (fs.existsSync(packagesDir)) return packagesDir;

    try {
      for (const entry of fs.readdirSync(projectPath, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name === 'node_modules') continue;
        const child = path.join(projectPath, entry.name);
        if (
          fs.existsSync(path.join(child, 'package.json')) &&
          fs.existsSync(path.join(child, 'packages'))
        ) {
          return path.join(child, 'packages');
        }
      }
    } catch {
      // 目录读取失败则回退项目根
    }
    return projectPath;
  }

  private resolveConfigs(options: ToolScanOptions): string[] {
    const cfgs = options.config?.config;
    if (!cfgs) return [];
    if (Array.isArray(cfgs)) return cfgs as string[];
    if (typeof cfgs === 'string') return [cfgs];
    return [];
  }
}
