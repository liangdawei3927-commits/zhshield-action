/**
 * 按域建任务的执行契约（《07》§7.4 / C5 / A13 / A14）。
 *
 * 这一层在工具级 `execution/Scheduler` **之上**：Scheduler 管"一域内的工具如何合并执行、
 * 单工具超时怎么收敛"，本层管"十个域各跑什么、跑多久、谁挂了不拖累谁"。
 *
 * 为什么需要它：桌面端把「每域跑什么」写死在 `electron/pipeline-jobs.ts`（依赖
 * Electron 子进程端口），CLI 只有"门禁 + 巡检"两阶段路径。于是同一份编排有两个入口，
 * 且**没有任何无头路径能跑全量域** —— A14（总时长 ≤180s）因此无法复测、无法做回归门禁。
 * 把编排下沉到 pipeline 后：桌面端退化为薄调用（进度文案 + 落盘），CLI / 无头脚本
 * 用同一批执行器，逐域耗时账本只有一处产出。
 *
 * 域状态复用 `@zh/shared` 的 `DomainRunStatus`，不另造词表：
 * `not-run` 表示"本次没跑"（不是 0 分，不是通过），`unavailable` 表示"跑了但不可用
 * （预算耗尽 / 工序缺失）"。两者都不得被折算成数字（C4）。
 */
import type { DomainId, DomainRunStatus } from '@zh/shared';
import type { RuleContext, RuleEngineReport } from '@zh/kernel';
import type { DepsScanInput } from './deps-scan';

/** 执行器向调度层回报的单域结论 */
export interface DomainExecution {
  /** 缺省 `ok`；`partial` = 部分工序跳过（如垃圾域规则通道降级） */
  status?: Extract<DomainRunStatus, 'ok' | 'partial' | 'unavailable'>;
  /** 域报告，原样透传给消费方（schema 由该域自己定义） */
  report?: unknown;
  /** 非致命附加信息（基线豁免条数、工具跳过清单等），供调用方拼进度文案 */
  detail?: Record<string, unknown>;
  /** `status !== 'ok'` 时的原因（禁止空串：说不出原因就是没想清楚） */
  reason?: string;
}

/** 执行器收到的一次运行上下文 */
export interface DomainExecutionContext {
  /** 已归一化的项目根（绝对路径） */
  repoRoot: string;
  /**
   * 状态根：用户打开的原始项目路径（**容器目录下探前**），域快照的读写根。
   *
   * `repoRoot` 可能因「容器目录下探」被解析到嵌套仓库，而各域快照（inspect /
   * deps / security）与 latest.json 都写在用户打开的项目下。门禁按 O8 读结论
   * 必须用它，否则会读到嵌套仓库里另一份（可能过期的）快照。
   * 缺省回退 `repoRoot`，兼容无头调用与存量调用方。
   */
  stateRoot?: string;
  /**
   * 规则驱动的域（inspect / guard / garbage）需要的 `PipelineRunner`。
   * 由调用方按各自装配口径创建（桌面端经 `createLoadedRunner` 合并云同步规则，
   * CLI 用内置模板），**本层不自建** —— 否则又会造出第二份规则集。
   */
  runner?: PipelineRunnerLike;
  /** 进度 / 工具事件透传；桌面端映射到 IPC 进度，无头调用可不传 */
  onEvent?: (event: DomainEvent) => void;
  /**
   * 门禁域的只判不改（桌面端一键体检可传 `true`）。
   * 缺省 `false`，与 CLI `guard --sop` 的默认口径一致。
   */
  dryRun?: boolean;
  /**
   * 依赖域的宿主注入（CVE 网络查询、锁文件基线、画像）。
   * 缺省 = CVE 未检测（`cve.status=unavailable`，≠ 0 漏洞）——无头调用如实标注，
   * 不假装"查过且干净"（C4 / A15）。
   */
  depsScanInput?: DepsScanInput;
}

/**
 * 结构化的进度事件。
 *
 * 刻意不传翻译后的文案：pipeline 是引擎层，i18n 归展示层（桌面端）。
 * 事件里只带"发生了什么"（域 / 种类 / 载荷），文案由消费方按自己的语言渲染。
 */
export interface DomainEvent {
  domain: DomainId;
  /** 事件种类，如 `tool:scan-started` / `tool:executed` */
  kind: string;
  payload?: Record<string, unknown>;
}

/** 域执行器：一域一个，**只跑本域职责**（C1/C3），不得借调他域触发权 */
export type DomainExecutor = (ctx: DomainExecutionContext) => Promise<DomainExecution>;

/** 单域执行记录（A14 的分域账本就由这些记录累加） */
export interface DomainRunRecord {
  domain: DomainId;
  status: DomainRunStatus;
  /** 实际耗时（毫秒）；`not-run` 恒 0 */
  durationMs: number;
  /** 该域预算（毫秒）；运行时常量域（哨兵/备份）无预算 */
  budgetMs?: number;
  /** 是否超出预算（超预算的域照 A13 只影响自己，其余域继续） */
  overBudget?: boolean;
  report?: unknown;
  detail?: Record<string, unknown>;
  reason?: string;
}

/** 一次全量运行的账本 */
export interface DomainRunLedger {
  repoRoot: string;
  /** ISO 8601 */
  startedAt: string;
  /** 各域耗时之和（并发 > 1 时不等于墙钟耗时；墙钟见 `wallMs`） */
  sumMs: number;
  /** 墙钟耗时（毫秒） */
  wallMs: number;
  concurrency: number;
  records: DomainRunRecord[];
}

/**
 * `PipelineRunner` 的最小结构依赖。
 *
 * 不直接 import 该类是为了避免 `pipeline-runner.ts → domains/ → pipeline-runner.ts`
 * 的循环；执行器只声明"我需要哪几个方法"，装配责任留在调用方。
 */
export interface PipelineRunnerLike {
  repoRoot: string;
  runSopInspect(context?: Partial<RuleContext>): Promise<RuleEngineReport>;
  runSopGuard(context?: Partial<RuleContext>): Promise<RuleEngineReport>;
}

/** 运行参数 */
export interface DomainRunOptions {
  repoRoot: string;
  /** 状态根（用户打开的项目路径，下探前）；缺省回退 `repoRoot` */
  stateRoot?: string;
  /** 要跑的域；缺省 = 静态扫描八域（`SCAN_DOMAIN_BUDGETS` 的键） */
  domains?: readonly DomainId[];
  runner?: PipelineRunnerLike;
  /** 域级预算覆盖；缺省读 `SCAN_DOMAIN_BUDGETS`，表内没有的域不设预算 */
  budgets?: Partial<Record<DomainId, number>>;
  /** 覆盖默认执行器（桌面端注入 techdebt 等需要宿主能力的域） */
  executors?: Partial<Record<DomainId, DomainExecutor>>;
  /** 全局并发上限；缺省 1（8GB Intel Mac 资源纪律，见 §7.5） */
  concurrency?: number;
  onEvent?: (event: DomainEvent) => void;
  /** 门禁域 dry-run；缺省 false */
  dryRun?: boolean;
  /** 依赖域宿主注入；缺省 CVE 未检测（`unavailable`，不是 0 漏洞） */
  depsScanInput?: DepsScanInput;
  /** 时钟（测试注入用，缺省 `Date.now`） */
  now?: () => number;
}
