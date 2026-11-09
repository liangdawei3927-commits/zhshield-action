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
  /**
   * `--domains <a,b,c>`：只跑指定域（缺省 = 全量扫描链）。
   *
   * 存在的理由不只是省时间：C5「单域可独立运行」要求任一域能单独出结论，
   * 而在此之前 CLI 根本没有触发单域的入口 —— 该契约在 CLI 侧无法验证。
   */
  domains?: string;
  baselineAction?: 'capture' | 'list' | 'clear' | 'capture-refactor' | 'clear-refactor';
  /** `sop` 命令的子动作；目前只有 sync（缺省值） */
  sopAction?: 'sync';
  /**
   * `--hook <pre-commit|pre-push>`：由 git 钩子触发的门禁判定阶段。
   *
   * 语义与 `--sop` 一致（纯判定、只读各域既有结论、不派发扫描器，见《07》O8），
   * 差别只在「证据缺失时如何收场」：钩子是用户显式安装的准入入口，缺证据按
   * `ZH_GATE_REQUIRE_SOP` 决定是否升格为失败，并把触发阶段写进门禁历史。
   */
  hook?: HookStage;
}

/** git 钩子阶段（与 `.git/hooks` 下的文件名同名，避免两套命名） */
export const HOOK_STAGES = ['pre-commit', 'pre-push'] as const;
export type HookStage = (typeof HOOK_STAGES)[number];

export function isHookStage(raw: string | undefined): raw is HookStage {
  return typeof raw === 'string' && (HOOK_STAGES as readonly string[]).includes(raw);
}

/**
 * `--hook=<stage>` 等号写法；非法值直接退出，禁止静默忽略（钩子会以为门禁跑过了）。
 * 返回 undefined 表示「不是 --hook= 形式」。
 */
export function parseHookEquals(arg: string): CLIOptions['hook'] | undefined {
  if (!arg.startsWith('--hook=')) return undefined;
  const raw = arg.slice('--hook='.length);
  if (!isHookStage(raw)) {
    console.error(`[CLI] 非法 --hook 值: ${raw || '(空)'}，合法值: ${HOOK_STAGES.join(' | ')}`);
    process.exit(2);
  }
  return raw;
}

/**
 * 解析 `--hook` / `--hook=<stage>`，命中时写入 opts 并返回「本参数消耗到的下标」。
 *
 * 抽到 cli-options.ts 是为了让 index.ts 的 `parseFlags` 不再因钩子分支过长触发
 * `long-method` 门禁；返回 undefined 表示当前参数不是钩子开关。
 */
export function applyHookFlag(
  args: string[],
  index: number,
  opts: CLIOptions,
): number | undefined {
  const equals = parseHookEquals(args[index] ?? '');
  if (equals !== undefined) {
    opts.hook = equals;
    return index;
  }
  if (args[index] !== '--hook') return undefined;
  const raw = args[index + 1];
  if (!isHookStage(raw)) {
    console.error(`[CLI] 非法 --hook 值: ${raw ?? '(空)'}，合法值: ${HOOK_STAGES.join(' | ')}`);
    process.exit(2);
  }
  opts.hook = raw;
  return index + 1;
}
