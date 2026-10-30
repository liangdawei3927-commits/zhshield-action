import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Logger, SopLoader, SopRegistry } from '@zh/kernel';
import { toMessage } from './runner-utils';

/**
 * SOP 规则装载（内置模板 + 云同步缓存）。
 *
 * 从 `PipelineRunner` 类体抽出（2026-10-29）：装载是纯 I/O 编排，不含引擎状态，
 * 留在类里只会让类体突破 300 行门禁。抽出的同时保留原有语义：
 *   · 内置 0 条 = **盲检**，必须 error 级告警（静默通过是最坏结果）；
 *   · 缓存目录缺失 / 模块解析失败 = 正常降级，warn 后回退内置模板；
 *   · 合并由 `SopLoader.loadFromKnowledgeBase` 负责（REMOTE_WINS 按 id 覆盖）。
 */

type SyncRuleArray = Parameters<SopLoader['loadFromKnowledgeBase']>[0];

/** 已注册规则的统计口径 */
export interface SopStats {
  readonly total: number;
  readonly active: number;
}

/**
 * 读取规则注册表统计。
 *
 * 条数**只能**取 `registry.getAll()`：加载器返回值会把缺 metadata 的规则合成
 * `{domain}.{action}.official.{文件名}` 伪 id 一并计数，用它报条数会偏大，
 * 进而让「N 条规则参与判定」这句话失真（CLI 横幅与桌面端面板都吃这个数）。
 *
 * 之所以放在本模块而不是 `PipelineRunner` 类里：这是**注册表操作**，不含编排状态；
 * 类体已顶到 `large-class` 阈值，再往里塞纯读写逻辑只能靠删注释腾地方。
 */
export function readSopStats(registry: SopRegistry): SopStats {
  const all = registry.getAll();
  return { total: all.length, active: all.filter((rule) => rule.status === 'active').length };
}

/** 规则载入所需的三个协作者：加载器、注册表、日志（便于用例注入替身） */
export interface SopRuleLoadingDeps {
  loader: SopLoader;
  registry: SopRegistry;
  logger: Logger;
}

/** 载入内置规则模板；返回加载条数（0 表示盲检，已打 error） */
export async function loadBundledSopRules(
  deps: SopRuleLoadingDeps & { rulesDir?: string },
): Promise<number> {
  const count = await deps.loader.loadFromFileSystem();
  const stats = deps.registry.getStats();
  if (count === 0) {
    deps.logger.error(
      `SOP 规则加载降级: 0 条规则 — 引擎处于盲检状态，所有检查将默认通过。请检查规则目录: ${deps.rulesDir}`,
    );
  } else {
    deps.logger.info(`SOP 规则已加载: ${count} 条 (活跃: ${stats.byStatus.active || 0})`);
  }
  return count;
}

/**
 * 从同步缓存加载云端规则（`{cacheDir}/modules/*.db`，JSON 数组）并与内置模板合并。
 * 返回加载条数；目录缺失或无规则文件时返回 0（属正常降级，不是错误）。
 */
export async function loadSopRulesFromSyncCache(
  deps: SopRuleLoadingDeps,
  cacheDir: string,
): Promise<number> {
  const modulesDir = path.join(cacheDir, 'modules');
  const files = await readModulesDir(deps.logger, modulesDir);
  if (!files) return 0;

  const dbFiles = files.filter((f) => f.endsWith('.db') && !f.startsWith('.'));
  if (dbFiles.length === 0) return 0;

  const synced = await readSyncedRules(deps.logger, modulesDir, dbFiles);
  if (synced.length === 0) return 0;

  await deps.loader.loadFromKnowledgeBase(synced);
  const stats = deps.registry.getStats();
  deps.logger.info(`SOP 同步规则已加载: ${synced.length} 条 (活跃: ${stats.byStatus.active || 0})`);
  return synced.length;
}

async function readModulesDir(logger: Logger, modulesDir: string): Promise<string[] | null> {
  try {
    return await fs.promises.readdir(modulesDir);
  } catch {
    logger.warn(`同步规则缓存目录不可用，回退内置模板: ${modulesDir}`);
    return null;
  }
}

async function readSyncedRules(
  logger: Logger,
  modulesDir: string,
  dbFiles: string[],
): Promise<SyncRuleArray> {
  const synced: SyncRuleArray = [];
  for (const file of dbFiles) {
    try {
      const raw = await fs.promises.readFile(path.join(modulesDir, file), 'utf-8');
      const rules = JSON.parse(raw) as SyncRuleArray;
      if (Array.isArray(rules)) synced.push(...rules);
    } catch (err) {
      logger.warn(`同步规则模块 ${file} 解析失败: ${toMessage(err)}`);
    }
  }
  return synced;
}
