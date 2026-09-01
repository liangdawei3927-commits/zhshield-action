import type { ToolScanOptions } from '@zh/shared';
import { SemgrepRuleWriter } from './semgrep-rule-writer';

/**
 * SemgrepScanArgsBuilder — 组装 semgrep scan 命令行参数（含内联规则写入与排除目录）
 *
 * 职责：把扫描配置（configs / 内联 rules / 排除目录）编排为 semgrep CLI 参数序列。
 * 内联规则的 YAML 写入委托给 SemgrepRuleWriter，本类只负责参数顺序与 --config 追加。
 */
export class SemgrepScanArgsBuilder {
  private readonly ruleWriter = new SemgrepRuleWriter();

  /** 组装 semgrep scan 命令行参数（含内联规则写入与排除目录） */
  async build(options: ToolScanOptions, configs: string[], targetDir: string): Promise<string[]> {
    const args: string[] = ['scan', '--json', '--optimizations', 'all'];
    this.appendConfigArgs(args, configs);
    await this.appendInlineRuleArgs(args, options, targetDir);
    this.appendExcludeArgs(args);
    args.push(targetDir);
    return args;
  }

  /** 追加 --config 参数 */
  private appendConfigArgs(args: string[], configs: string[]): void {
    for (const c of configs) {
      args.push('--config', c);
    }
  }

  /** 写入内联规则并追加 --config 参数 */
  private async appendInlineRuleArgs(
    args: string[],
    options: ToolScanOptions,
    targetDir: string,
  ): Promise<void> {
    const rulePath = await this.ruleWriter.writeInlineRuleConfig(options, targetDir);
    if (rulePath) args.push('--config', rulePath);
  }

  /** 追加排除生成目录与测试夹具目录的参数 */
  private appendExcludeArgs(args: string[]): void {
    // 排除生成目录与测试夹具目录，避免扫描 dist/assets 下的规则文件触发自身误报，
    // 以及把刻意构造的恶意测试样例（如 __tests__/fixtures/conflict-resolver/evil.ts）当生产代码上报（对齐 refactor 引擎约定）
    for (const excl of [
      'node_modules',
      'dist',
      'build',
      '.semgrep',
      'coverage',
      '__tests__',
      'fixtures',
      '__fixtures__',
      '__mocks__',
    ]) {
      args.push('--exclude', excl);
    }
  }
}
