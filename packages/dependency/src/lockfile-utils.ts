import * as fs from 'node:fs';
import { load as loadYaml } from 'js-yaml';

/**
 * lockfile-utils — 锁文件解析的通用纯工具。
 *
 * 这些函数原先在 graph-builder / env-consistency / lockfile-verifier 中被
 * 逐字复制，现收敛为唯一实现，三处 import 复用，避免行为分叉。
 * 全部为无副作用、确定性的纯函数。
 */

/** 判断值是否为普通对象（非 null、非数组） */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 安全读取 JSON 文件；解析失败返回 null */
export function readJsonSafe(filePath: string): Record<string, unknown> | null {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return isRecord(data) ? data : null;
  } catch {
    // 无法解析时按缺失处理
    return null;
  }
}

/** 安全读取 YAML 文件；解析失败返回 null */
export function readYamlSafe(filePath: string): unknown {
  try {
    return loadYaml(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    // 无法解析时按缺失处理
    return null;
  }
}

/** 安全读取文本文件；读取失败返回 null */
export function readTextSafe(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    // 无法读取时按缺失处理
    return null;
  }
}

/** 匹配精确版本约束 `==` / `===` */
const EXACT_CONSTRAINT_RE = /^(?:==|===)\s*(.+)$/;

/** 剥离版本开头的非数字前缀 */
const NON_DIGIT_PREFIX_RE = /^[^0-9]*/;

/** 匹配 poetry 版本值 `version = "x.y.z"` */
const POETRY_VERSION_VALUE_RE = /version\s*=\s*["']([^"']+)["']/;

/** 从约束中提取版本号 */
export function versionFromConstraint(constraint: string): string {
  const trimmed = constraint.trim();
  const first = trimmed.split(',')[0].trim();
  const exact = first.match(EXACT_CONSTRAINT_RE);
  if (exact) return exact[1].trim();
  return first.replace(NON_DIGIT_PREFIX_RE, '').trim();
}

/** 解析 poetry 版本约束（含 `{ version = "..." }` 表与引号包裹） */
export function parsePoetryConstraint(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('{')) {
    const m = trimmed.match(POETRY_VERSION_VALUE_RE);
    return m ? m[1] : '';
  }
  let result = trimmed;
  if (
    result.length >= 2 &&
    (result.startsWith('"') || result.startsWith("'")) &&
    (result.endsWith('"') || result.endsWith("'"))
  ) {
    result = result.slice(1, -1);
  }
  return result;
}
