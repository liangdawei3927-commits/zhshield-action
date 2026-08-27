/**
 * npm outdated 适配器（npm-outdated.ts）
 *
 * 通过 `npm outdated --json` 获取项目可更新依赖列表。
 * 返回 OutdatedDependencyInfo[]，结构与 electron.d.ts 中 OutdatedDependencyData 对齐。
 *
 * 设计约束：
 * - 零新依赖：不引入 semver 等第三方库
 * - 只读：不修改 package.json / lockfile
 * - npm outdated 无法判断是否为安全更新（isSecurityUpdate 默认 false），
 *   安全引擎（trivy / osv）负责补充该信息
 */
import { execFile as execFileCb } from 'child_process';
import * as fs from 'fs';
import { promisify } from 'util';
import { safeJoin } from '@zh/shared';

const execFileAsync = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** 可更新依赖信息（与 electron.d.ts OutdatedDependencyData 结构对齐） */
export interface OutdatedDependencyInfo {
  /** 包名，如 'lodash' */
  name: string;
  /** 当前已安装版本 */
  current: string;
  /** 最新发布版本 */
  latest: string;
  /** 是否为安全更新（npm outdated 无法确定，默认 false；由安全引擎补充） */
  isSecurityUpdate: boolean;
  /** 额外说明（如 npm 的 deprecated 信息） */
  description?: string;
}

/** npm outdated 命令失败时抛出的错误类型 */
export type NpmOutdatedErrorCode =
  | 'NO_PACKAGE_JSON'
  | 'NPM_NOT_FOUND'
  | 'NPM_COMMAND_FAILED'
  | 'JSON_PARSE_ERROR';

/** npm outdated 适配器专属错误，携带结构化错误码 */
export class NpmOutdatedError extends Error {
  public readonly code: NpmOutdatedErrorCode;

  constructor(message: string, code: NpmOutdatedErrorCode) {
    super(message);
    this.name = 'NpmOutdatedError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** npm outdated --json 中单个包的原始输出结构 */
interface NpmOutdatedEntry {
  current?: string;
  wanted?: string;
  latest?: string;
  location?: string;
}

/** execFile 抛出的错误可能携带 stdout / stderr */
interface ExecErrorWithOutput extends Error {
  stdout?: string;
  stderr?: string;
  code?: string | number;
}

/** 判断值是否为普通对象（非 null、非数组） */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 判断值是否包含 npm outdated 条目的核心字段 */
function isNpmOutdatedEntry(value: unknown): value is NpmOutdatedEntry {
  return isRecord(value);
}

/** 判断 exec 错误是否为 "npm 未找到" */
function isNpmNotFound(error: ExecErrorWithOutput): boolean {
  const code = error.code;
  if (typeof code === 'string' && code === 'ENOENT') return true;
  const msg = error.message.toLowerCase();
  return msg.includes('enoent') || msg.includes('not found');
}

/** 安全提取错误消息 */
function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * 检查项目中有哪些 npm 依赖可更新。
 *
 * @param projectPath - 项目根目录（必须包含 package.json）
 * @returns 可更新依赖列表；无过期依赖时返回空数组
 * @throws {NpmOutdatedError} 当 package.json 不存在、npm 不可用或命令执行失败时
 *
 * @example
 * ```ts
 * const outdated = await checkOutdated('/path/to/project');
 * for (const dep of outdated) {
 *   console.log(`${dep.name}: ${dep.current} → ${dep.latest}`);
 * }
 * ```
 */
export async function checkOutdated(projectPath: string): Promise<OutdatedDependencyInfo[]> {
  // 1. 校验 package.json 存在
  const pkgJsonPath = safeJoin(projectPath, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) {
    throw new NpmOutdatedError(
      `未找到 package.json：${pkgJsonPath}`,
      'NO_PACKAGE_JSON',
    );
  }

  // 2. 执行 npm outdated --json
  let stdout: string;
  try {
    const result = await execFileAsync('npm', ['outdated', '--json'], {
      cwd: projectPath,
      timeout: 30_000,
      encoding: 'utf-8',
    });
    stdout = result.stdout;
  } catch (error: unknown) {
    // npm outdated 在发现过期依赖时以 exit code 1 退出——这是预期行为
    if (isExecErrorWithOutput(error) && error.stdout && error.stdout.trim() !== '') {
      stdout = error.stdout;
    } else if (isExecErrorWithOutput(error) && isNpmNotFound(error)) {
      throw new NpmOutdatedError(
        'npm 未安装或不在 PATH 中',
        'NPM_NOT_FOUND',
      );
    } else {
      throw new NpmOutdatedError(
        `npm outdated 命令执行失败：${toErrorMessage(error)}`,
        'NPM_COMMAND_FAILED',
      );
    }
  }

  // 3. 空输出 → 无过期依赖
  const trimmed = stdout.trim();
  if (trimmed === '' || trimmed === '{}') {
    return [];
  }

  // 4. 解析 JSON
  let parsed: Record<string, unknown>;
  try {
    const raw: unknown = JSON.parse(trimmed);
    if (!isRecord(raw)) {
      throw new NpmOutdatedError(
        'npm outdated 输出的 JSON 结构异常（非对象）',
        'JSON_PARSE_ERROR',
      );
    }
    parsed = raw;
  } catch (error: unknown) {
    if (error instanceof NpmOutdatedError) throw error;
    throw new NpmOutdatedError(
      'npm outdated 输出的 JSON 解析失败',
      'JSON_PARSE_ERROR',
    );
  }

  // 5. 映射为 OutdatedDependencyInfo[]
  const results: OutdatedDependencyInfo[] = [];

  for (const [name, entry] of Object.entries(parsed)) {
    if (!isNpmOutdatedEntry(entry)) continue;

    const { current, latest } = entry;

    // 跳过缺少版本信息的条目
    if (current == null || latest == null) continue;

    // 跳过已是最新版本的包
    if (current === latest) continue;

    results.push({
      name,
      current,
      latest,
      isSecurityUpdate: false,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Type guard for execFile errors (must be a named function for no bare throws)
// ---------------------------------------------------------------------------

function isExecErrorWithOutput(error: unknown): error is ExecErrorWithOutput {
  return typeof error === 'object' && error !== null && 'stdout' in error;
}
