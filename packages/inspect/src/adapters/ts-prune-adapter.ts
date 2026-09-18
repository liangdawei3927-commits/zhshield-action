import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  ToolAdapter,
  ToolMeta,
  ToolResult,
  ToolScanOptions,
  Issue,
  AccessScope,
} from '@zh/shared';
import { resolveToolCommand } from './tool-bin';

const execFileAsync = promisify(execFile);

const META: ToolMeta = {
  id: 'ts-prune',
  name: 'ts-prune',
  category: 'inspect',
  priority: 'P1',
  installMode: 'builtin',
  description: 'TypeScript 死代码/未导出检测',
  cliCommand: 'ts-prune',
  homepage: 'https://github.com/nadeesha/ts-prune',
  license: 'MIT',
};

/**
 * ts-prune 输出行格式（2026-09-18 实测 ts-prune@0.10.x）。
 *
 * 真机输出用「破折号」分隔，不是冒号：
 *   src/orphan.ts:1 - neverImportedAnywhere
 * 历史/变体格式用冒号：
 *   src/orphan.ts:1: neverImportedAnywhere
 *
 * 🔴 事故记录：本适配器此前只有 /^(.+?):(\d+):\s*(.+)$/（只认冒号），而真实输出是
 *   破折号 → 每一行 parse 都返回 null → issues 恒为 [] → tool-dispatch 判
 *   `available && issues.length===0` → 规则显示「工具 ts-prune 检查通过」。
 *   即「死代码检测」长期静默零检出、永远打勾。成因是 mapOutput 无任何测试覆盖
 *   （既有 ts-prune-adapter.test.ts 只测 isAvailable）。两种分隔符都必须显式支持。
 */
const TS_PRUNE_DASH_LINE = /^(.+?):(\d+)\s+-\s+(.+)$/;
const TS_PRUNE_COLON_LINE = /^(.+?):(\d+):\s*(.+)$/;

/**
 * ts-prune 对「仅被本模块自己引用」的导出会加此后缀（如
 * `vitest.shared.ts:37 - createVitestConfig (used in module)`）。
 * 该类符号**确有调用方**，不属死代码；不过滤会在每个项目上产生海量假阳性。
 */
const USED_IN_MODULE = /\s*\(used in module\)\s*$/;

interface PruneEntry {
  file: string;
  line: number;
  symbol: string;
}

/**
 * 解析单行 ts-prune 输出。返回 null 表示该行不是可用条目
 * （格式不识别，或为 used-in-module 噪音）。
 */
export function parsePruneLine(rawLine: string): PruneEntry | null {
  const trimmed = rawLine.trim();
  if (!trimmed) return null;
  const match = trimmed.match(TS_PRUNE_DASH_LINE) ?? trimmed.match(TS_PRUNE_COLON_LINE);
  if (!match) return null;
  const [, file, lineStr, rawSymbol] = match;
  if (USED_IN_MODULE.test(rawSymbol)) return null;
  const symbol = rawSymbol.replace(USED_IN_MODULE, '').trim();
  if (!symbol) return null;
  return { file: file.trim(), line: parseInt(lineStr, 10) || 0, symbol };
}

/** 解析 ts-prune 完整 stdout（纯文本，逐行） */
export function parseTsPruneOutput(raw: string): PruneEntry[] {
  if (!raw || !raw.trim()) return [];
  return raw
    .split('\n')
    .map((line) => parsePruneLine(line))
    .filter((e): e is PruneEntry => e !== null);
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** 多个正则合并为单个（ts-prune 每次只接受一个 -s / -i RegExp）。单项原样返回，避免多余分组 */
function joinRegexes(patterns: string[]): string {
  return patterns.length === 1 ? patterns[0] : `(${patterns.join('|')})`;
}

/**
 * 组装 ts-prune 命令行参数。
 * 规则可通过 check.toolConfig 声明：
 *   · skip   → -s：判定"是否被使用"时跳过的文件（框架注册型文件，如 NestJS 控制器/模块）
 *   · ignore → -i：从报告中整体排除的路径
 * 二者是规则侧消除误报的唯一手段（NestJS 项目不跳过会产生大量假阳性）。
 */
export function buildTsPruneArgs(options: ToolScanOptions, tsConfigPath: string): string[] {
  // ⚠️ 不带 --json：实机 ts-prune@0.10.x 忽略该开关（仍输出纯文本），而 mapOutput 是
  // 纯文本解析器。保留 --json 意味着「若某版本开始真正生效 → 输出变 JSON → 解析全部失败
  // → 又变成静默零检出」。宁可显式声明只要文本输出，也不要留一个会退化成长的隐患。
  const args = ['-p', tsConfigPath];
  const cfg = options.config as Record<string, unknown> | undefined;
  const skip = asStringArray(cfg?.skip);
  if (skip.length > 0) args.push('-s', joinRegexes(skip));
  const ignore = asStringArray(cfg?.ignore);
  if (ignore.length > 0) args.push('-i', joinRegexes(ignore));
  return args;
}

export class TsPruneAdapter implements ToolAdapter {
  meta = META;
  /** 按锚点（projectRoot ?? projectPath）缓存解析结果；isAvailable 的无锚点 PATH 探测与 scan 的项目本地解析互不污染（09-12 复验修复） */
  private readonly commandCache = new Map<string, Promise<string>>();
  private readonly projectRoot?: string;

  /** F5：ts-prune 基于 tsconfig 分析 TS 源码的未导出符号 */
  readonly accessScope: AccessScope = {
    readPaths: ['**/*.{ts,tsx}', '**/tsconfig.json'],
    excludePaths: ['**/node_modules/**'],
  };

  constructor(projectRoot?: string) {
    this.projectRoot = projectRoot;
  }

  private resolveCommand(projectPath?: string): Promise<string> {
    // 锚定 projectPath，不受 cwd 影响（09-12 复验修复）：anchor = projectRoot ?? projectPath，
    // 无锚点时仅 PATH/共享目录探测（isAvailable 用），scan 时以 options.projectPath 锚定本地 bin。
    const anchor = this.projectRoot ?? projectPath;
    const key = anchor ?? '';
    let cached = this.commandCache.get(key);
    if (!cached) {
      cached = resolveToolCommand('ts-prune', anchor);
      this.commandCache.set(key, cached);
    }
    return cached;
  }

  async isAvailable(): Promise<boolean> {
    // ts-prune 的 `--version` 不短路：会连同参数当作项目扫描真实执行（实测输出为全量
    // 未导出报告而非版本号），>20s 超时 → isCommandAvailable 误判未安装。
    // 改为检查解析出的命令文件存在且可执行（解析链已覆盖本地 bin / PATH / zhshield bin）。
    try {
      const command = await this.resolveCommand();
      if (path.isAbsolute(command)) {
        await fs.promises.access(command, fs.constants.X_OK);
        return true;
      }
      // 裸命令名（PATH 上解析到）：逐 PATH 目录查找可执行文件，避免执行 --version
      const pathEnv = process.env.PATH ?? '';
      for (const dir of pathEnv.split(path.delimiter)) {
        if (!dir) continue;
        try {
          await fs.promises.access(path.join(dir, command), fs.constants.X_OK);
          return true;
        } catch {
          // 该目录无此命令，继续下一个 PATH 目录
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  async scan(options: ToolScanOptions): Promise<ToolResult> {
    const start = Date.now();
    try {
      return await this.runTsPrune(options, start);
    } catch (error: unknown) {
      return this.handleTsPruneError(error, start);
    }
  }

  /** 执行 ts-prune 并映射输出为可用结果 */
  private async runTsPrune(options: ToolScanOptions, start: number): Promise<ToolResult> {
    // 归一化 projectPath 为绝对路径：相对路径会流入 cwd 与 tsconfig 相对化，
    // ts-prune 以自身 cwd 解析相对路径导致扫描失败。
    const projectPath = path.resolve(options.projectPath);
    // ts-prune@0.10.3 runner 内部用 path.join(process.cwd(), tsConfigPath) 组装路径，
    // 传绝对路径会翻倍（cwd/projectPath + 绝对路径）；cwd 已是 projectPath，故传相对路径。
    const tsConfigAbsPath = path.resolve(projectPath, 'tsconfig.json');
    const tsConfigPath = path.relative(projectPath, tsConfigAbsPath);
    // 锚定 projectPath，不受 cwd 影响（09-12 复验修复）：以扫描目标锚定本地 bin 解析
    const command = await this.resolveCommand(projectPath);
    const { stdout } = await execFileAsync(command, buildTsPruneArgs(options, tsConfigPath), {
      cwd: projectPath,
      timeout: options.timeout || 60000,
      maxBuffer: 10 * 1024 * 1024,
    });

    const issues = this.mapOutput(stdout);

    return {
      tool: 'ts-prune',
      status: 'available',
      issues,
      metadata: {
        version: '',
        duration: Date.now() - start,
        timestamp: new Date(),
        fileCount: issues.length,
      },
    };
  }

  /** 处理 ts-prune 执行错误：未安装 / 部分输出 / 失败 */
  private handleTsPruneError(error: unknown, start: number): ToolResult {
    const err = error as { code?: string; stdout?: string; stderr?: string; message?: string };
    if (err.code === 'ENOENT') {
      return {
        tool: 'ts-prune',
        status: 'unavailable',
        issues: [],
        metadata: {
          version: '',
          duration: Date.now() - start,
          timestamp: new Date(),
          fileCount: 0,
        },
        error: 'ts-prune 未安装',
      };
    }

    if (err.stdout) {
      const issues = this.mapOutput(err.stdout);
      if (issues.length > 0) {
        return {
          tool: 'ts-prune',
          status: 'available',
          issues,
          metadata: {
            version: '',
            duration: Date.now() - start,
            timestamp: new Date(),
            fileCount: issues.length,
          },
        };
      }
    }

    return {
      tool: 'ts-prune',
      status: 'error',
      issues: [],
      metadata: { version: '', duration: Date.now() - start, timestamp: new Date(), fileCount: 0 },
      error: err.stderr || err.message || 'ts-prune 执行失败',
    };
  }

  private mapOutput(raw: string): Issue[] {
    return parseTsPruneOutput(raw).map(({ file, line, symbol }) => ({
      id: randomUUID(),
      ruleId: 'ts-prune/unused-export',
      severity: 'info',
      category: 'quality',
      message: `未使用的导出: ${symbol}`,
      file,
      line,
      column: 0,
      suggestion: `移除未使用的导出符号: ${symbol}`,
      autoFixable: false,
      source: 'inspect',
      fingerprint: `ts-prune:${file}:${line}:${symbol}`,
    }));
  }
}
