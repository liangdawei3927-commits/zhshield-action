// zhshield CLI 选项契约：解析结果类型 CLIOptions（index.ts 与 commands.ts 共同消费）。
// 自 index.ts 原样抽出（仅搬移，无逻辑改动）。
import type { FailOn } from '@zh/reporter';

/** 命令行解析结果（command/dir/输出与门禁选项） */
export interface CLIOptions {
  command: string;
  dir: string;
  dryRun: boolean;
  sop: boolean;
  verbose: boolean;
  color: boolean;
  help: boolean;
  format: 'text' | 'json' | 'sarif';
  report: string;
  failOn: FailOn;
  baselineAction?: 'capture' | 'list' | 'clear' | 'capture-refactor' | 'clear-refactor';
}
