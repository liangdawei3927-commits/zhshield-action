import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolId } from './tool-rule-sync';

const TOOLRULE_PREFIX = 'toolrule:';

/**
 * 读取能力引用账本（capability-refs.json），收集 status === 'reclaiming' 的 toolrule:* 工具。
 *
 * 账本 schema（只读侧）：
 *   { "schemaVersion": 1, "capabilities": { "toolrule:eslint": { ..., "status": "reclaiming" } } }
 *
 * 缺文件 / JSON 损坏 / 结构异常 → 返回空 Set（绝不抛）。
 */
export function getReclaimingToolRuleIds(baseDir: string): Set<ToolId> {
  const reclaiming = new Set<ToolId>();
  try {
    const raw = fs.readFileSync(path.join(baseDir, 'capability-refs.json'), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return reclaiming;
    const capabilities = (parsed as { capabilities?: unknown }).capabilities;
    if (typeof capabilities !== 'object' || capabilities === null) return reclaiming;
    for (const [key, value] of Object.entries(capabilities)) {
      if (!key.startsWith(TOOLRULE_PREFIX)) continue;
      const entry = value as { status?: unknown } | null;
      if (entry !== null && typeof entry === 'object' && entry.status === 'reclaiming') {
        reclaiming.add(key.slice(TOOLRULE_PREFIX.length) as ToolId);
      }
    }
  } catch {
    // 缺文件 / JSON 损坏 / 结构异常 → 空集
  }
  return reclaiming;
}

/**
 * 读取能力引用账本，收集 status === 'reclaiming' 的 toolrule:* 工具 → since（epoch ms）。
 *
 * 仅收录 since 为有限正数的条目；缺失/非法 since 的条目被排除（保守方向：宁留不删）。
 * 缺文件 / JSON 损坏 / 结构异常 → 返回空 Map（绝不抛）。
 */
export function getReclaimingToolRuleSinces(baseDir: string): Map<ToolId, number> {
  const sinces = new Map<ToolId, number>();
  try {
    const raw = fs.readFileSync(path.join(baseDir, 'capability-refs.json'), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return sinces;
    const capabilities = (parsed as { capabilities?: unknown }).capabilities;
    if (typeof capabilities !== 'object' || capabilities === null) return sinces;
    for (const [key, value] of Object.entries(capabilities)) {
      if (!key.startsWith(TOOLRULE_PREFIX)) continue;
      const entry = value as { status?: unknown; since?: unknown } | null;
      if (entry !== null && typeof entry === 'object' && entry.status === 'reclaiming') {
        const since = entry.since;
        if (typeof since === 'number' && Number.isFinite(since) && since > 0) {
          sinces.set(key.slice(TOOLRULE_PREFIX.length) as ToolId, since);
        }
      }
    }
  } catch {
    // 缺文件 / JSON 损坏 / 结构异常 → 空 Map
  }
  return sinces;
}