/**
 * 垃圾清理 IPC 边界入参校验（garbage-input.ts）
 *
 * 主进程 IPC handler 对渲染进程的入参**不得盲信**：渲染进程唯一合法调用方是自己，
 * 但同源 XSS 可调用 `engine:garbageClean` / `engine:garbageRestore` 提交任意 payload。
 * ipc-security 只校验发送方来源（frame URL），不校验内容，因此内容校验必须在本层完成。
 *
 * 本模块是**纯函数**模块：不 import electron、无任何副作用，可在 vitest node 环境下单测。
 */

/** 校验通过后的垃圾清理条目（与 @zh/garbage 的 GarbageCleanInput 结构一致） */
export interface ValidGarbageCleanItem {
  id: string;
  path: string;
  size: number;
  type: string;
  reason?: string;
}

/** 批量校验结果：ok=true 携带净化后的条目；ok=false 携带首条错误信息 */
export type GarbageCleanItemsResult =
  | { ok: true; items: ValidGarbageCleanItem[] }
  | { ok: false; error: string };

/** 规范化 UUID（v4 形态）：仅接受标准 8-4-4-4-12 十六进制，大小写不敏感 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 是否为「普通对象」：非 null、非数组的对象字面量（拒绝函数/数组/null） */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 是否绝对路径：POSIX `/`、Windows 盘符 `C:\` / `C:/`、UNC `\\` 前缀 */
function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\');
}

/** 路径是否含 `..` 段（同时按 `/` 与 `\` 切分，兼容两种分隔符） */
function hasParentSegment(p: string): boolean {
  return p.split(/[\\/]/).some((segment) => segment === '..');
}

/**
 * 逐元素校验路径：非空字符串、非绝对路径、无 `..` 段、无 NUL 字节。
 * 合法时返回收窄后的字符串，非法时返回错误信息。
 */
function validatePath(
  path: unknown,
  index: number,
): { ok: true; path: string } | { ok: false; error: string } {
  if (typeof path !== 'string' || path.length === 0) {
    return { ok: false, error: `Item at index ${index} has invalid "path": expected a non-empty string` };
  }
  if (path.includes('\0')) {
    return { ok: false, error: `Item at index ${index} has unsafe "path": NUL bytes are not allowed` };
  }
  if (isAbsolutePath(path)) {
    return { ok: false, error: `Item at index ${index} has unsafe "path": absolute paths are not allowed` };
  }
  if (hasParentSegment(path)) {
    return { ok: false, error: `Item at index ${index} has unsafe "path": ".." segments are not allowed` };
  }
  return { ok: true, path };
}

/** 校验单个条目并返回净化后的对象；非法时返回错误信息 */
function validateItem(
  raw: unknown,
  index: number,
): { item: ValidGarbageCleanItem } | { error: string } {
  if (!isPlainObject(raw)) {
    return { error: `Item at index ${index} must be a plain object` };
  }
  if (typeof raw.id !== 'string' || raw.id.length === 0) {
    return { error: `Item at index ${index} has invalid "id": expected a non-empty string` };
  }
  const pathResult = validatePath(raw.path, index);
  if (!pathResult.ok) return { error: pathResult.error };
  if (typeof raw.size !== 'number' || !Number.isFinite(raw.size) || raw.size < 0) {
    return { error: `Item at index ${index} has invalid "size": expected a finite number >= 0` };
  }
  if (typeof raw.type !== 'string') {
    return { error: `Item at index ${index} has invalid "type": expected a string` };
  }
  if (raw.reason !== undefined && typeof raw.reason !== 'string') {
    return { error: `Item at index ${index} has invalid "reason": expected a string` };
  }
  return {
    item: {
      id: raw.id,
      path: pathResult.path,
      size: raw.size,
      type: raw.type,
      ...(raw.reason !== undefined ? { reason: raw.reason } : {}),
    },
  };
}

/**
 * 批量校验垃圾清理入参：非数组或首个非法元素即整批拒绝（ok=false）。
 * 通过时返回**净化后的新对象数组**（不直接透传原始引用）。
 */
export function validateGarbageCleanItems(input: unknown): GarbageCleanItemsResult {
  if (!Array.isArray(input)) {
    return { ok: false, error: 'Garbage clean payload must be an array of items' };
  }
  const items: ValidGarbageCleanItem[] = [];
  for (let index = 0; index < input.length; index++) {
    const result = validateItem(input[index], index);
    if ('error' in result) {
      return { ok: false, error: result.error };
    }
    items.push(result.item);
  }
  return { ok: true, items };
}

/** 批次 ID 是否规范：仅 UUID 形态为真，其余（'..' / 'a/b' / '' / 'abc' 等）一律为假 */
export function isValidBatchId(input: unknown): boolean {
  return typeof input === 'string' && UUID_RE.test(input);
}
