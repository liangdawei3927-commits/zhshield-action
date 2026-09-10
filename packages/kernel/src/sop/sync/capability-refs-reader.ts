import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolId } from './tool-rule-sync';

const TOOLRULE_PREFIX = 'toolrule:';
const SOP_MODULE_PREFIX = 'sop-module:';

/** 账本中单条能力条目（只读侧最小视图） */
interface CapabilityEntry {
  status?: unknown;
  since?: unknown;
}

/**
 * 读取能力引用账本（capability-refs.json）的 capabilities 条目。
 *
 * 缺文件 / JSON 损坏 / 结构异常 → 返回空数组（绝不抛）。
 */
function readCapabilityEntries(baseDir: string): Array<[string, CapabilityEntry]> {
  try {
    const raw = fs.readFileSync(path.join(baseDir, 'capability-refs.json'), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return [];
    const capabilities = (parsed as { capabilities?: unknown }).capabilities;
    if (typeof capabilities !== 'object' || capabilities === null) return [];
    const entries: Array<[string, CapabilityEntry]> = [];
    for (const [key, value] of Object.entries(capabilities)) {
      if (value !== null && typeof value === 'object') {
        entries.push([key, value as CapabilityEntry]);
      }
    }
    return entries;
  } catch {
    // 缺文件 / JSON 损坏 / 结构异常 → 空数组
    return [];
  }
}

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
  for (const [key, entry] of readCapabilityEntries(baseDir)) {
    if (!key.startsWith(TOOLRULE_PREFIX)) continue;
    if (entry.status === 'reclaiming') {
      reclaiming.add(key.slice(TOOLRULE_PREFIX.length) as ToolId);
    }
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
  for (const [key, entry] of readCapabilityEntries(baseDir)) {
    if (!key.startsWith(TOOLRULE_PREFIX)) continue;
    if (entry.status === 'reclaiming') {
      const since = entry.since;
      if (typeof since === 'number' && Number.isFinite(since) && since > 0) {
        sinces.set(key.slice(TOOLRULE_PREFIX.length) as ToolId, since);
      }
    }
  }
  return sinces;
}

/**
 * 读取能力引用账本（capability-refs.json），收集 status === 'reclaiming' 的 sop-module:* 模块。
 *
 * 账本 schema（只读侧）：
 *   { "schemaVersion": 1, "capabilities": { "sop-module:typescript": { ..., "status": "reclaiming" } } }
 *
 * 缺文件 / JSON 损坏 / 结构异常 → 返回空 Set（绝不抛）。
 */
export function getReclaimingSopModuleIds(baseDir: string): Set<string> {
  const reclaiming = new Set<string>();
  for (const [key, entry] of readCapabilityEntries(baseDir)) {
    if (!key.startsWith(SOP_MODULE_PREFIX)) continue;
    if (entry.status === 'reclaiming') {
      reclaiming.add(key.slice(SOP_MODULE_PREFIX.length));
    }
  }
  return reclaiming;
}

/**
 * 读取能力引用账本，收集 status === 'reclaiming' 的 sop-module:* 模块 → since（epoch ms）。
 *
 * 仅收录 since 为有限正数的条目；缺失/非法 since 的条目被排除（保守方向：宁留不删）。
 * 缺文件 / JSON 损坏 / 结构异常 → 返回空 Map（绝不抛）。
 */
export function getReclaimingSopModuleSinces(baseDir: string): Map<string, number> {
  const sinces = new Map<string, number>();
  for (const [key, entry] of readCapabilityEntries(baseDir)) {
    if (!key.startsWith(SOP_MODULE_PREFIX)) continue;
    if (entry.status === 'reclaiming') {
      const since = entry.since;
      if (typeof since === 'number' && Number.isFinite(since) && since > 0) {
        sinces.set(key.slice(SOP_MODULE_PREFIX.length), since);
      }
    }
  }
  return sinces;
}