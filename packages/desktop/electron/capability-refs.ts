/**
 * 能力引用计数账本（capability-refs.ts）
 *
 * R2 能力引用计数回收（06 §3.3 引用计数模型 + §6.1/§6.2 文件级清单）：
 * 让"能力与项目的关系"从无记名的全局共享缓存变成可记账、可回收、可唤醒的
 * 引用计数闭环。账本文件落 ~/.zhshield/capability-refs.json（与
 * tool-rule-versions.json 同级），kernel 侧只读、desktop 侧写入。
 *
 * R3 能力到期物理删除（06 §4.3 + §9-R3）：reclaiming 到期 → reclaimed 终态标记（at），
 * 账本 languages 从恒 [] 变为云端下发值（数据面；投影判定不用它）。
 *
 * 本模块为纯函数 + 文件 I/O，只依赖 node:fs/os/path/crypto，
 * 不 import ipc-context / electron（保持可单测，temp baseDir 注入）。
 * 仅 ipc-context import 本模块（单向依赖），deriveProjectId 在此单源。
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { ToolId } from '@zh/kernel';

/** 能力条目状态：active = 有项目引用；reclaiming = refs 空、进入 7 天回收窗口；reclaimed = 已物理删除（终态） */
export type CapabilityStatus = 'active' | 'reclaiming' | 'reclaimed';

/** 单个能力条目（06 §2.1 schema） */
export interface CapabilityEntry {
  /** 能力适用的语言（R2 恒空数组占位，R3 云端元数据接入后填充；投影判定不用它） */
  languages: string[];
  /** 引用该能力的项目 id 集合（幂等去重） */
  refs: string[];
  /** 能力状态；reclaiming ⇔ refs 空（不变量） */
  status?: CapabilityStatus;
  /** 仅 reclaiming 时存在 = refs 归零时刻 epoch ms（7 天窗口起算点） */
  since?: number;
  /** 仅 reclaimed 时存在 = 物理删除时刻 epoch ms */
  at?: number;
}

/** 能力引用账本（06 §2.1 schema） */
export interface CapabilityRefs {
  schemaVersion: 1;
  capabilities: Record<string, CapabilityEntry>;
}

/** 账本文件默认路径：~/.zhshield/capability-refs.json */
export function defaultCapabilityRefsPath(): string {
  return path.join(os.homedir(), '.zhshield', 'capability-refs.json');
}

/** 由 projectPath 推导稳定 projectId（sha256 前 16 位 hex，与云端同算法） */
export function deriveProjectId(projectPath: string): string {
  return crypto.createHash('sha256').update(projectPath).digest('hex').slice(0, 16);
}

/** 能力键构造辅助：toolrule:<toolId> */
export function capabilityIdOf(toolId: ToolId): string {
  return `toolrule:${toolId}`;
}

/** toolId → languages 映射（R3-b；Partial：云端可能未下发某工具） */
export type LanguagesByTool = Partial<Record<ToolId, string[]>>;

/** 空账本（缺文件 / 损坏 JSON 的保守降级） */
function emptyRefs(): CapabilityRefs {
  return { schemaVersion: 1, capabilities: {} };
}

/**
 * 读取账本。缺失 / 损坏 JSON → 空账本（保守降级，不抛）。
 * 解析成功但结构异常（capabilities 非对象）同样降级为空账本。
 * 异步（主进程禁止 fs 同步 IO，no-fs-sync 门禁）。
 */
export async function loadCapabilityRefs(
  filePath = defaultCapabilityRefsPath(),
): Promise<CapabilityRefs> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(filePath, 'utf-8');
  } catch {
    return emptyRefs();
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as { schemaVersion?: unknown }).schemaVersion === 1 &&
      typeof (parsed as { capabilities?: unknown }).capabilities === 'object' &&
      (parsed as { capabilities?: unknown }).capabilities !== null
    ) {
      return parsed as CapabilityRefs;
    }
    return emptyRefs();
  } catch {
    return emptyRefs();
  }
}

/**
 * 原子写账本：旁 tmp 文件 + rename（防崩溃半写）。
 * 目录不存在则 mkdir recursive。异步（no-fs-sync 门禁）。
 */
export async function saveCapabilityRefs(
  refs: CapabilityRefs,
  filePath = defaultCapabilityRefsPath(),
): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
  await fs.promises.writeFile(tmpPath, JSON.stringify(refs, null, 2), 'utf-8');
  await fs.promises.rename(tmpPath, filePath);
}

/**
 * 领取：对每个 toolId 幂等把 projectId 加入 refs（去重）。
 * 若该能力当时 reclaiming 且 refs 从空变非空 → 置回 active 并删除 since（唤醒）。
 * languagesByTool 可选：R3-b 云端下发 languages 写入条目（缺省 → 保持既有 languages，新条目恒 []）。
 * 返回新对象（不可原地改）。
 */
export function claimToolRefs(
  refs: CapabilityRefs,
  projectId: string,
  toolIds: ToolId[],
  languagesByTool?: LanguagesByTool,
): CapabilityRefs {
  const capabilities: Record<string, CapabilityEntry> = {};
  for (const [key, entry] of Object.entries(refs.capabilities)) {
    capabilities[key] = { ...entry, refs: [...entry.refs] };
  }

  for (const toolId of toolIds) {
    const key = capabilityIdOf(toolId);
    const entry = capabilities[key] ?? { languages: [], refs: [] };
    const languages = languagesByTool?.[toolId];
    if (languages !== undefined) {
      entry.languages = [...languages];
    }
    const wasEmpty = entry.refs.length === 0;
    if (!entry.refs.includes(projectId)) {
      entry.refs.push(projectId);
    }
    // 唤醒：refs 从空变非空且此前 reclaiming → active + since 清除
    if (wasEmpty && entry.refs.length > 0 && entry.status === 'reclaiming') {
      entry.status = 'active';
      delete entry.since;
    }
    capabilities[key] = entry;
  }

  return { schemaVersion: 1, capabilities };
}

/**
 * 归还：从所有 capabilities 条目（含 sop-module:* 键，通用遍历）移除该 projectId。
 * refs 变空的能力 → status: 'reclaiming' + since: Date.now()。
 * 返回新对象（不可原地改）。
 */
export function releaseProjectRefs(refs: CapabilityRefs, projectId: string): CapabilityRefs {
  const capabilities: Record<string, CapabilityEntry> = {};
  for (const [key, entry] of Object.entries(refs.capabilities)) {
    const nextRefs = entry.refs.filter((id) => id !== projectId);
    const next: CapabilityEntry = { ...entry, refs: nextRefs };
    if (nextRefs.length === 0) {
      next.status = 'reclaiming';
      next.since = Date.now();
    }
    capabilities[key] = next;
  }
  return { schemaVersion: 1, capabilities };
}

/**
 * 标记物理删除：将给定 toolrule:* 条目从 reclaiming → reclaimed + at: Date.now()，
 * 并删除 since（窗口起算点已无意义）。refs 保留（审计；reclaimed 与运行层无关）。
 * 仅处理当前 status === 'reclaiming' 的条目；不存在 / 已 reclaimed / active 均不动。
 * 返回新对象（不可原地改）。
 */
export function markReclaimed(refs: CapabilityRefs, toolIds: ToolId[]): CapabilityRefs {
  const capabilities: Record<string, CapabilityEntry> = {};
  for (const [key, entry] of Object.entries(refs.capabilities)) {
    capabilities[key] = { ...entry, refs: [...entry.refs] };
  }

  for (const toolId of toolIds) {
    const key = capabilityIdOf(toolId);
    const entry = capabilities[key];
    if (entry !== undefined && entry.status === 'reclaiming') {
      entry.status = 'reclaimed';
      entry.at = Date.now();
      delete entry.since;
    }
  }

  return { schemaVersion: 1, capabilities };
}

/**
 * 拆分云端 resolve 结果（R3-b）：toolId 清单（运行层 setRemoteToolIds 用）
 * + languagesByTool 映射（账本 claim 写入用）。纯函数，仅形状转换。
 */
export function splitResolvedTools(
  tools: Array<{ toolId: string; languages: string[] }>,
): { toolIds: ToolId[]; languagesByTool: LanguagesByTool } {
  const toolIds: ToolId[] = [];
  const languagesByTool: LanguagesByTool = {};
  for (const tool of tools) {
    toolIds.push(tool.toolId as ToolId);
    languagesByTool[tool.toolId as ToolId] = [...tool.languages];
  }
  return { toolIds, languagesByTool };
}

/**
 * 收集 reclaiming 的工具 id（toolrule:* 且 status === 'reclaiming'）。
 * 供测试与 kernel 契约对照。
 */
export function getReclaimingToolIds(refs: CapabilityRefs): ToolId[] {
  const ids: ToolId[] = [];
  for (const [key, entry] of Object.entries(refs.capabilities)) {
    if (key.startsWith('toolrule:') && entry.status === 'reclaiming') {
      ids.push(key.slice('toolrule:'.length) as ToolId);
    }
  }
  return ids;
}
