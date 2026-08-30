import * as fs from 'node:fs';
import path from 'node:path';

/**
 * 当由不可信路径段计算出的路径逃出预期基目录（路径穿越）时抛出。
 */
export class PathTraversalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathTraversalError';
  }
}

/**
 * 断言 `joined` 保持在 `resolvedBase` 之内（含基目录本身）。
 * 路径逃出时抛出 {@link PathTraversalError}。
 */
function assertContained(joined: string, resolvedBase: string, base: string): void {
  if (joined !== resolvedBase && !joined.startsWith(resolvedBase + path.sep)) {
    throw new PathTraversalError(
      `Path traversal detected: resolved path "${joined}" escapes base "${base}"`,
    );
  }
}

/**
 * 将不可信 `segments` 拼接到 `base` 上，规范化结果，并断言结果保持在
 * `path.resolve(base)` 之内。
 *
 * 对合法（界内）输入，返回值与 `path.join(base, ...segments)` 完全一致，
 * 因此调用点可直接替换而不改变行为。拼接结果逃出基目录时抛出
 * {@link PathTraversalError}。
 */
export function safeJoin(base: string, ...segments: string[]): string {
  const resolvedBase = path.resolve(base);
  const joined = path.normalize([resolvedBase, ...segments].join('/'));
  assertContained(joined, resolvedBase, base);
  // 行为保持：与 path.join(base, ...segments) 一致。
  return path.isAbsolute(base) ? joined : path.relative(process.cwd(), joined);
}

/**
 * 将不可信 `target` 相对 `base` 解析，规范化结果，并断言结果保持在
 * `path.resolve(base)` 之内。
 *
 * 对合法（界内）输入，返回值与 `path.resolve(base, target)` 完全一致。
 * 解析结果逃出基目录（含指向其外的绝对 target）时抛出
 * {@link PathTraversalError}。
 */
export function safeResolve(base: string, target: string): string {
  const resolvedBase = path.resolve(base);
  // path.resolve 将绝对 target 视为绝对路径（忽略 base），此处先镜像该语义再做包含检查。
  const resolved = path.isAbsolute(target)
    ? path.normalize(target)
    : path.normalize([resolvedBase, target].join('/'));
  assertContained(resolved, resolvedBase, base);
  return resolved;
}

/**
 * 解析 `p` 最近一个「已存在」祖先的 realpath（向上逐级查找）。
 * 找不到任何已存在祖先（到达文件系统根）时返回 null。
 * 用于在 `p` 本身尚不存在时仍能检测符号链接逃逸。
 */
function realpathPrefix(p: string): string | null {
  let cur = p;
  // 限制迭代次数，避免病态循环
  for (let i = 0; i < 100; i++) {
    try {
      return fs.realpathSync(cur);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return null; // 到达根目录
      cur = parent;
    }
  }
  return null;
}

/**
 * 同 {@link safeJoin}，但额外通过 fs.realpathSync 校验已存在路径前缀，
 * 确保解析路径中的任何符号链接都不会逃出 `base`。当 `base` 可能包含不可信
 * 符号链接（例如扫描不可信仓库）时使用——否则 existsSync/statSync/readdirSync
 * 会跟随指向 `base` 之外的符号链接。对界内、无符号链接的输入，返回值与
 * {@link safeJoin} 完全一致。当路径（或其 base）尚不存在时，realpath 校验
 * 被跳过，仅保留词法包含检查。
 */
export function safeJoinReal(base: string, ...segments: string[]): string {
  const resolvedBase = path.resolve(base);
  const joined = path.normalize([resolvedBase, ...segments].join('/'));
  assertContained(joined, resolvedBase, base); // 先做词法检查
  const baseReal = realpathPrefix(resolvedBase);
  const joinedReal = realpathPrefix(joined);
  if (joinedReal !== null) {
    const anchor = baseReal ?? resolvedBase;
    if (joinedReal !== anchor && !joinedReal.startsWith(anchor + path.sep)) {
      throw new PathTraversalError(
        `Symlink escape detected: resolved path "${joined}" (realpath "${joinedReal}") escapes base "${base}"`,
      );
    }
  }
  return path.isAbsolute(base) ? joined : path.relative(process.cwd(), joined);
}

/**
 * 同 {@link safeResolve}，但额外通过 fs.realpathSync 校验已存在路径前缀，
 * 确保解析路径中的任何符号链接都不会逃出 `base`。词法上镜像
 * {@link safeResolve} 的语义（绝对 target 忽略 base），随后应用与
 * {@link safeJoinReal} 相同的 realpath 强制：解析 base 与 target 的 realpath，
 * 当 targetReal 逃出 baseReal 时抛出 {@link PathTraversalError}。
 * 当目标（或其 base）尚不存在时，realpath 校验被跳过，仅保留词法包含检查。
 * 对界内、无符号链接的输入，返回值与 {@link safeResolve} 完全一致。
 */
export function safeResolveReal(base: string, target: string): string {
  const resolvedBase = path.resolve(base);
  // path.resolve 将绝对 target 视为绝对路径（忽略 base），此处先镜像该语义再做包含检查。
  const resolved = path.isAbsolute(target)
    ? path.normalize(target)
    : path.normalize([resolvedBase, target].join('/'));
  assertContained(resolved, resolvedBase, base); // 先做词法检查
  const baseReal = realpathPrefix(resolvedBase);
  const resolvedReal = realpathPrefix(resolved);
  if (resolvedReal !== null) {
    const anchor = baseReal ?? resolvedBase;
    if (resolvedReal !== anchor && !resolvedReal.startsWith(anchor + path.sep)) {
      throw new PathTraversalError(
        `Symlink escape detected: resolved path "${resolved}" (realpath "${resolvedReal}") escapes base "${base}"`,
      );
    }
  }
  return resolved;
}
