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
  /** `pipeline --full`：跑全量扫描链（七域逐域账本），不跑门禁判定 */
  full?: boolean;
  baselineAction?: 'capture' | 'list' | 'clear' | 'capture-refactor' | 'clear-refactor';
  /** `sop` 命令的子动作；目前只有 sync（缺省值） */
  sopAction?: 'sync';
}
