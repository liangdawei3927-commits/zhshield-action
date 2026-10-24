import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AccessScope, Issue, ToolMeta, ToolResult, ToolScanOptions } from '@zh/shared';
import { resolveToolCommand } from './tool-bin';
import { isCommandAvailable } from './tool-available';

/**
 * 公共适配器脚手架 — 收敛 11 个 tool adapter 之间逐字重复的样板
 *
 * 动机（jscpd duplication 巡检，阈值 minLines=10 / minTokens=50 / minSimilarity=80）：
 * depcheck / prettier / gitleaks / jscpd / eslint / semgrep / ts-prune / typescript /
 * dependency-cruiser 九个适配器各自复制了同一套样板——`execFile` + `promisify` 的 import 头、
 * `accessScope.readPaths` 声明、`execFileAsync(command, args, { cwd, timeout, maxBuffer })` 调用、
 * 带锚点缓存的 `resolveCommand` / `isAvailable`、以及内联的 ToolResult 字面量构建；
 * 加上 commit-lint / npm-audit 复制的 ToolResult 构建，jscpd 在 depcheck-adapter.ts
 * 单文件上就报出 19 处命中。本模块把这些样板收成唯一实现，各适配器只保留自己的
 * META、参数组装与输出映射。
 *
 * 语义保持严格等价（逐项对齐原实现，不改阈值 / 路径 / 错误文案 / 退出码）：
 * · 命令解析锚点顺序（projectRoot ?? projectPath）、缓存 key、可探测性判定不变；
 * · ToolResult 的 tool / status / issues / metadata / error 字段与取值不变；
 * · `execTool` 失败时**原样抛出** child_process 的错误对象（保留 code/stdout/stderr/message），
 *   错误归类（未安装 / 部分输出 / 执行失败）仍由各适配器按自身文案处理。
 */

/** 11 个适配器共用的 promise 化 execFile（各适配器不再单独 promisify） */
const execFileAsync = promisify(execFile);

/**
 * 单次工具扫描的默认超时（ms）。
 *
 * 必须与上层硬上限对齐，否则护栏形同虚设：InspectEngine 的
 * ToolAdapterExecutor.hardTimeoutMs 与内核 dispatch 的 DEFAULT_TOOL_SCAN_TIMEOUT_MS
 * 都是 300_000，而各适配器原先各自写死 `options.timeout || 60000` —— 内层在 60s
 * 先死，外层那个 5 分钟护栏永远没有机会生效。
 *
 * 实测代价（本仓 1155 个 TS 源文件，8GB Intel Mac）：全仓 ts-prune 需 60–90s，
 * 卡在原 60s 默认值的临界点上，同一命令四次运行得到 available(59.9s) /
 * error(60.3s) / error(60.5s) 三种结果 —— 死代码规则在大项目上表现为
 * 「工具执行失败」而非「零检出」，且随机器负载漂移。
 */
export const DEFAULT_TOOL_SCAN_TIMEOUT_MS = 300_000;

/** stdout 默认缓冲上限：10MB，与各适配器原先硬编码的 `10 * 1024 * 1024` 一致 */
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;

/** 依赖目录排除模式：11 个适配器中 8 个使用同一份 excludePaths */
const NODE_MODULES_EXCLUDE = '**/node_modules/**';

/** child_process 执行失败时的诊断字段（全部可选，未设置即该通道无内容） */
export interface ToolExecError {
  /** 失败码：ENOENT=命令不存在；非零退出码为进程退出码；**超时被 SIGTERM 时为 null** */
  code?: string | number;
  /**
   * 是否为 execFile 因 `timeout` 到期而主动 kill。
   *
   * Node 不会把超时映射成 `code: 'ETIMEDOUT'`（此前本文件的注释如此断言，导致
   * 各适配器从未真正识别过超时），而是置 `killed: true` + `signal: 'SIGTERM'`
   * 且 `code: null`。因此超时必须经 isToolTimeout 判定。
   */
  killed?: boolean;
  /** 子进程被杀时的信号；超时场景为 'SIGTERM' */
  signal?: string | null;
  /** 失败前已写出的 stdout（部分工具「命中问题」时仍为完整报告，属正常路径） */
  stdout?: string;
  /** stderr 内容（各工具的失败原因通常在此） */
  stderr?: string;
  /** 错误消息（child_process 附加的最后兜底文案） */
  message?: string;
}

/**
 * 判定一次工具执行失败是否为「超时被 kill」而非「工具自身报错」。
 *
 * 超时的现场特征：stdout/stderr 双空 + message 形如
 * `Command failed: <cmd>\n`（child_process 拼装，stderr 为空故只剩换行），
 * 且 killed=true / signal='SIGTERM'。工具在缓冲区写完前被杀时同样双空，
 * 例如 eslint（--format json 末尾一次性输出）与 gitleaks（--report-path -）。
 * 此类失败必须给出「超时」结论：把双空当成工具报错会把门禁失败原因
 * 误报成不可读的 `Command failed: ...`。
 */
export function isToolTimeout(err: ToolExecError): boolean {
  if (err.killed === true) return true;
  return err.code === null && err.signal === 'SIGTERM' && !err.stdout && !err.stderr;
}

/**
 * 把任意捕获值收敛为 ToolExecError 形状。
 *
 * 纯类型收窄，不做任何语义判断：ENOENT / ETIMEDOUT / 部分输出等判定仍由各适配器
 * 按自身文案处理。消除 9 处逐字重复的 `error as { code?…; stdout?…; stderr?…; message?… }`。
 */
export function asToolExecError(error: unknown): ToolExecError {
  return error as ToolExecError;
}

/** execTool 的执行选项 */
export interface ToolExecOptions {
  /** 工作目录；缺省时由 child_process 沿用进程 cwd（仅 `--version` 探测类调用不设） */
  cwd?: string;
  /** 超时（毫秒）——由调用方按各工具实测耗时显式给定，取值与原实现一致 */
  timeout: number;
  /** stdout 缓冲上限（字节）；缺省 10MB（git log 读 1MB 需显式覆盖） */
  maxBuffer?: number;
}

/** execTool 的出参（等价于原 `const { stdout } = await execFileAsync(…)`） */
export interface ToolExecOutput {
  stdout: string;
  stderr: string;
}

/**
 * 执行一次外部工具 CLI 调用并返回 stdout/stderr。
 *
 * 失败时原样抛出 child_process 的错误对象（携带 code/stdout/stderr/message），
 * 不在此处吞错或改写：各适配器的错误分支需要按自身语义区分「未安装」「命中问题但非零退出」
 * 与「执行失败」，文案与退出码判定必须逐条保持原样。
 */
export async function execTool(
  command: string,
  args: string[],
  options: ToolExecOptions,
): Promise<ToolExecOutput> {
  return execFileAsync(command, args, {
    cwd: options.cwd,
    timeout: options.timeout,
    maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
  });
}

/** ToolResult 终态：可用 / 不可用（跳过）/ 执行错误 */
export type ToolResultStatus = 'available' | 'unavailable' | 'error';

/** buildToolResult 的入参 */
export interface ToolResultInput {
  /** 工具 id（写入 ToolResult.tool，与各适配器 META.id 一致） */
  tool: ToolResult['tool'];
  /** 终态（写入 ToolResult.status） */
  status: ToolResultStatus;
  /** 已映射的问题列表；同时作为 metadata.fileCount 的缺省值 */
  issues: Issue[];
  /** 扫描开始时刻（Date.now() 基准），用于计算 metadata.duration */
  start: number;
  /** metadata.fileCount 覆盖值；缺省取 issues.length（gitleaks 等 issues 已过滤的场景需显式给出） */
  fileCount?: number;
  /** metadata.version；缺省空串（各适配器均不探测版本号，与原实现一致） */
  version?: string;
  /** 错误说明；按真值展开，空串与 undefined 均不写入 ToolResult.error（保持原实现语义） */
  error?: string;
}

/**
 * 构建 ToolResult —— 11 个适配器唯一的 ToolResult 出口。
 *
 * 字段与取值与各适配器原内联实现（含 BuiltinToolAdapter.buildToolMetadata）完全一致：
 * metadata 固定为 `{ version, duration, timestamp, fileCount }`，
 * `error` 沿用 `...(error ? { error } : {})` 的条件展开（避免空串产生 `error: ''`）。
 */
export function buildToolResult(input: ToolResultInput): ToolResult {
  return {
    tool: input.tool,
    status: input.status,
    issues: input.issues,
    metadata: {
      version: input.version ?? '',
      duration: Date.now() - input.start,
      timestamp: new Date(),
      fileCount: input.fileCount ?? input.issues.length,
    },
    ...(input.error ? { error: input.error } : {}),
  };
}

/**
 * 构建 AccessScope（F5 访问边界声明）。
 *
 * readPaths 逐适配器不同，不做归并；只收敛重复的「excludePaths 缺省即 node_modules」约定。
 */
export function buildAccessScope(readPaths: string[], excludePaths?: string[]): AccessScope {
  return {
    readPaths,
    excludePaths: excludePaths ?? [NODE_MODULES_EXCLUDE],
  };
}

/** 工具命令解析函数：入参为（工具名, 锚点目录），返回可执行命令路径或命令名 */
export type ToolCommandResolveFn = (tool: string, startDir?: string) => Promise<string>;

/**
 * ToolCommandResolver — 工具命令解析 + 可用性探测的唯一实现
 *
 * 锚点语义（09-12 复验修复，保持不变）：anchor = projectRoot ?? projectPath，
 * 无锚点时仅做 PATH / 共享目录探测（isAvailable 用），scan 时以 options.projectPath
 * 锚定项目本地 bin；解析结果按 anchor 缓存 Promise，使 isAvailable 的无锚点 PATH 探测与
 * scan 的项目本地解析互不污染。
 */
export class ToolCommandResolver {
  /** 按锚点缓存的解析结果（key = anchor，无锚点时为 ''） */
  private readonly cache = new Map<string, Promise<string>>();

  constructor(
    /** 工具名（传给 resolveToolCommand 的第一个入参） */
    private readonly tool: string,
    /** 宿主项目根；缺省时退化为按每次调用传入的 projectPath 锚定 */
    private readonly projectRoot?: string,
    /** 解析函数；缺省 resolveToolCommand（dependency-cruiser 需 detailed 变体时覆盖） */
    private readonly resolveFn: ToolCommandResolveFn = resolveToolCommand,
  ) {}

  /** 解析工具命令（按锚点缓存，重复调用不再触发 PATH 探测） */
  resolve(projectPath?: string): Promise<string> {
    const anchor = this.projectRoot ?? projectPath;
    const key = anchor ?? '';
    let cached = this.cache.get(key);
    if (!cached) {
      cached = this.resolveFn(this.tool, anchor);
      this.cache.set(key, cached);
    }
    return cached;
  }

  /** 可用性探测：解析命令后执行 `--version`，stdout 非空即视为可用（20s 超时） */
  async isAvailable(): Promise<boolean> {
    return isCommandAvailable(() => this.resolve());
  }
}

/** 适配器自持的执行失败文案（ENOENT 未安装 / 其余执行失败时的兜底文案） */
export interface ToolErrorTexts {
  /** 命令不存在（ENOENT）时的提示 */
  unavailable: string;
  /** stderr 与 message 均为空时的兜底提示 */
  failed: string;
}

/**
 * ToolCommandAdapter — CLI 型工具适配器的基类
 *
 * 收敛各适配器逐字重复的 `ToolAdapter` 骨架：命令解析器持有、`isAvailable` 委托、
 * `scan` 的计时 + try/catch 兜底、以及「ENOENT → unavailable / 其余 → error」的 ToolResult 构建。
 * 适配器只需提供 META、accessScope、`runScan` 与（需要自定义文案的）`errorTexts`。
 *
 * 语义保持严格等价：超时取值、错误分类条件（ENOENT）、`stderr || message || 兜底文案` 的
 * 取值顺序与原各适配器实现逐项一致。
 */
export abstract class ToolCommandAdapter {
  /** 工具元信息（各适配器自带的 META） */
  abstract meta: ToolMeta;
  /** F5 访问边界声明（各适配器自带的 readPaths，缺省 node_modules 排除由 buildAccessScope 给出） */
  abstract accessScope: AccessScope;
  /** 失败文案；未覆盖时取「未安装或未在 PATH 中找到」/「<tool> 执行失败」 */
  protected errorTexts: ToolErrorTexts;

  /** 命令解析器（构造时按工具名绑定，锚点语义见 ToolCommandResolver） */
  protected readonly commands: ToolCommandResolver;

  constructor(
    /** 工具名（与 META.id 同值，供 ToolCommandResolver 解析） */
    tool: string,
    /** 宿主项目根；缺省时按每次 scan 传入的 projectPath 锚定 */
    projectRoot?: string,
    /** 执行失败文案；缺省时按 tool 生成「未安装」/「执行失败」两条 */
    errorTexts?: ToolErrorTexts,
  ) {
    this.commands = new ToolCommandResolver(tool, projectRoot);
    this.errorTexts = errorTexts ?? {
      unavailable: `${tool} 未安装或未在 PATH 中找到`,
      failed: `${tool} 执行失败`,
    };
  }

  /** 可用性探测：解析命令后执行 `--version`（各适配器逐字相同，收敛到基类） */
  async isAvailable(): Promise<boolean> {
    return this.commands.isAvailable();
  }

  /** 扫描入口：统一 start 计时与异常兜底，异常一律降级为 ToolResult 而非上抛 */
  async scan(options: ToolScanOptions): Promise<ToolResult> {
    const start = Date.now();
    try {
      return await this.runScan(options, start);
    } catch (error: unknown) {
      return this.buildExecErrorResult(error, start);
    }
  }

  /** 把 child_process 失败对象收敛为 ToolExecError（语义判断仍由调用方按需处理） */
  protected execErrorOf(error: unknown): ToolExecError {
    return asToolExecError(error);
  }

  /**
   * 构建执行失败结果：ENOENT → unavailable（工具未安装），其余 → error。
   * 错误文案取 `stderr || message || errorTexts.failed`，与各适配器原实现一致。
   */
  protected buildExecErrorResult(error: unknown, start: number): ToolResult {
    const err = asToolExecError(error);
    if (err.code === 'ENOENT') {
      return buildToolResult({
        tool: this.meta.id,
        status: 'unavailable',
        issues: [],
        start,
        error: this.errorTexts.unavailable,
      });
    }
    return buildToolResult({
      tool: this.meta.id,
      status: 'error',
      issues: [],
      start,
      error: err.stderr || err.message || this.errorTexts.failed,
    });
  }

  /** 子类实现：真正的工具执行与输出映射（异常由基类 scan 兜底） */
  protected abstract runScan(options: ToolScanOptions, start: number): Promise<ToolResult>;
}
