/**
 * 主进程共享上下文（ipc-context.ts）
 *
 * 各 IPC 模块（ipc/*）与 main.ts 通过本模块共享主进程级单例：
 * - 主窗口引用（进度推送 / 窗口控制）
 * - SOP 缓存、智汇大脑协同（工具规则下发 + 经验回写）
 * - DB 连接、治理引擎（Scoring / Sentinel / Evolve）懒加载
 */

import { app, type BrowserWindow } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { t } from '@zh/i18n';

import {
  EventBus,
  SopRegistry,
  SopCacheManager,
  WisdomBrainSync,
  ToolRuleSync,
  ExperienceReporter,
  buildDefaultToolRuleConfigs,
  resolveApiBase,
  resolveSopBase,
  readApiToken,
  readOrCreateUserId,
  getOrCreateDefaultOrg,
  registerProjectFeatures,
  unregisterProjectFeatures,
  resolveTools as cloudResolveTools,
  resolveRules as cloudResolveRules,
  type ScopeProfileLike,
} from '@zh/kernel';
import { DbConnection } from '@zh/db';
import type { ScoringEngine } from '@zh/scoring';

/** 当前主窗口引用（由 main.ts createWindow 维护，供进度推送使用） */
let mainWindow: BrowserWindow | null = null;
export function setMainWindow(window: BrowserWindow | null): void {
  mainWindow = window;
}
export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

// 解决打包后路径问题
export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL'];

// ─── 智汇大脑：SOP 规则缓存管理器 ────────────────────────────
// dev 模式默认连本地后端（packages/server，3010），打包后用环境变量或正式域名。
// 显式设置 ZH_API_BASE / VITE_API_BASE 始终优先。
const DEV_DEFAULT_API_BASE = 'http://localhost:3010/api/v1';
export const API_BASE = resolveApiBase(
  process.env.ZH_API_BASE ||
    process.env.VITE_API_BASE ||
    (app.isPackaged ? undefined : DEV_DEFAULT_API_BASE),
);
export const eventBus = new EventBus();
export const sopRegistry = new SopRegistry(eventBus);

const SOP_BASE = resolveSopBase(API_BASE);

let cachedSopPublicKey: string | null | undefined;
/** 将公钥归一化为 SPKI PEM：已是 PEM 原样返回，否则按 raw base64 包裹 PEM 头 */
function normalizePublicKeyPem(key: string): string {
  if (key.includes('-----BEGIN PUBLIC KEY-----')) return key;
  const body = key.replace(/\s+/g, '');
  const lines = body.match(/.{1,64}/g) ?? [body];
  return ['-----BEGIN PUBLIC KEY-----', ...lines, '-----END PUBLIC KEY-----'].join('\n');
}
/** 解析 SOP 规则包验签公钥：优先环境变量 ZH_SOP_PUBLIC_KEY，否则从服务端 /public-key 发现 */
export async function resolveSopPublicKey(): Promise<string | null> {
  if (cachedSopPublicKey !== undefined) return cachedSopPublicKey;

  const pinned = process.env.ZH_SOP_PUBLIC_KEY;
  if (pinned) {
    cachedSopPublicKey = normalizePublicKeyPem(pinned);
    return cachedSopPublicKey;
  }

  try {
    const res = await fetch(`${SOP_BASE}/public-key`, { signal: AbortSignal.timeout(10_000) });
    if (res.ok) {
      const data = (await res.json()) as { publicKey?: string };
      cachedSopPublicKey = data.publicKey ? normalizePublicKeyPem(data.publicKey) : null;
    } else {
      cachedSopPublicKey = null;
    }
  } catch {
    cachedSopPublicKey = null;
  }
  return cachedSopPublicKey;
}

export const sopCache = new SopCacheManager(sopRegistry, {
  cacheDir: path.join(app.getPath('userData'), 'sop-cache'),
  remoteBaseUrl: SOP_BASE,
  syncPolicy: { syncInterval: 6 * 60 * 60 * 1000 }, // 6 小时
  publicKey: resolveSopPublicKey,
  apiToken: () => readApiToken(),
});

/** 智汇大脑协同：工具规则下发 + 经验回写 */
export const wisdomBrainSync = new WisdomBrainSync({
  toolRuleSync: new ToolRuleSync(buildDefaultToolRuleConfigs(API_BASE)),
  experienceReporter: new ExperienceReporter({ remoteUrl: `${API_BASE}/experience` }),
});

// ─── 画像驱动工具下发：当前项目画像缓存 ────────────────────
// 状态与存取实现在 profile-cache（纯内存、无 electron 副作用）；
// 此处 re-export 保持主进程既有导入路径不变。
// pipeline-worker 子进程构建必须直连 profile-cache（pipeline-jobs），
// 不得经本模块导入——否则 worker bundle 内联 electron 副作用 → fork 崩溃。
export type { CachedProjectFeature } from './profile-cache';
export { getCachedProfile, setCachedProfile, getCachedProfileProjectPath } from './profile-cache';
import type { CachedProjectFeature } from './profile-cache';

// ─── T0 云端画像注册 ─────────────────────────────────────────

import { deriveProjectId } from './capability-refs';

/**
 * 调用服务器 POST /orgs 创建默认组织，返回服务器生成的真实 orgId。
 * 返回 CreateOrgFn 供 getOrCreateDefaultOrg 复用（组织创建语义收敛在 kernel）。
 */
async function createDefaultOrg(body: {
  name: string;
  ownerId: string;
}): Promise<{ orgId: string }> {
  const res = await fetch(`${API_BASE}/orgs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-api-token': readApiToken(),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const err = new Error(`POST /orgs failed: ${res.status}`);
    (err as Error & { status: number }).status = res.status;
    throw err;
  }
  return (await res.json()) as { orgId: string };
}

/**
 * Fire-and-forget: 将项目画像快照注册到云端。
 * 失败仅 log，永不阻断流水线（离线降级）。
 */
export async function registerProjectFeaturesToCloud(
  feature: CachedProjectFeature,
  projectPath: string,
): Promise<void> {
  try {
    readApiToken(); // side-effect: 确保 API token 文件存在
    const userId = readOrCreateUserId();
    const org = await getOrCreateDefaultOrg(createDefaultOrg);
    if (!org) {
      console.warn('[cloud:T0] 无可用 orgId，跳过云端画像注册（离线降级）');
      return;
    }
    const projectId = deriveProjectId(projectPath);
    await registerProjectFeatures(org.orgId, userId, projectId, {
      framework: feature.framework,
      language: feature.language,
      features: feature.features,
    });
  } catch (err) {
    console.warn(
      '[cloud:T0] 云端画像注册失败，降级跳过:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Fire-and-forget: 注销项目云端画像快照（与 registerProjectFeaturesToCloud 对称）。
 * 失败仅 log，永不抛出（离线降级）。
 */
export async function unregisterProjectFeaturesFromCloud(projectPath: string): Promise<void> {
  try {
    readApiToken(); // side-effect: 确保 API token 文件存在
    const userId = readOrCreateUserId();
    const org = await getOrCreateDefaultOrg(createDefaultOrg);
    if (!org) {
      console.warn('[cloud:T0] 无可用 orgId，跳过云端画像注销（离线降级）');
      return;
    }
    const projectId = deriveProjectId(projectPath);
    await unregisterProjectFeatures(org.orgId, userId, projectId);
  } catch (err) {
    console.warn(
      '[cloud:T0] 云端画像注销失败，降级跳过:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** 获取默认 orgId（供 T1 在 sync 流程中使用）；失败/离线返回 null */
export async function getDefaultOrgId(): Promise<string | null> {
  try {
    const org = await getOrCreateDefaultOrg(createDefaultOrg);
    return org?.orgId ?? null;
  } catch {
    return null;
  }
}

export { cloudResolveTools, cloudResolveRules, type ScopeProfileLike };

// ─── 治理引擎依赖：DB ──────────────────────────────────────
// DB 初始化失败不应阻断主进程启动 — 降级为无持久化模式（与 server 端 SopService/SentinelService 一致）。
// HTTP 模式下 renderer 走服务端，不依赖本地 DB；IPC 模式下评分/哨兵持久化退化为内存态。
const dbPath = path.join(app.getPath('userData'), 'zh-codeshield.db');
const dbConn = new DbConnection({ dbPath });
let db: ReturnType<DbConnection['connect']> | null = null;
// 迁移完成句柄：e2e 冷启动可能立即触发写表 IPC，需先 await 迁移结束（否则 no such table）。
// 生产路径不依赖该句柄，语义不变；无 db 时 resolve 空（降级模式）。
let dbReady: Promise<void> = Promise.resolve();
try {
  db = dbConn.connect();
  // 迁移目录按存在性探测而非 VITE_DEV_SERVER_URL 开关：
  // 生产打包（electron-builder extraResources）→ resources/db/migrations；
  // dev / e2e 裸跑 vite build 产物无 resources → 回退仓库源码迁移目录（packages/db/migrations），
  // 保证迁移真实执行（否则 DB 空库、写表 IPC 报 no such table）。
  // 探测放在异步链内（主进程禁止 fs 同步 IO，no-fs-sync 门禁）。
  const packagedMigrations = path.resolve(__dirname, 'resources/db/migrations');
  const fallbackMigrations = path.resolve(__dirname, '../../db/migrations');
  // 迁移在微任务中异步执行，远早于任何 IPC 处理器（处理器仅在窗口创建后触发）
  // access 失败（目录缺失）或 migrate 抛错均吞掉：
  // migrate 内部对目录缺失已优雅处理（existsSync 短路），解析为空 Promise 即可。
  dbReady = fs.promises
    .access(packagedMigrations)
    .then(() => packagedMigrations)
    .catch(() => fallbackMigrations)
    .then((migrationsDir) => dbConn.migrate(migrationsDir))
    .catch(() => {});
  void dbReady;
} catch (err) {
  console.error(
    `[ipc-context] DB 初始化失败，降级为无持久化模式: ${err instanceof Error ? err.message : String(err)}`,
  );
  db = null;
}

/** 等待本地 DB 迁移完成（测试专用观测 IPC 冷启动时使用） */
export function whenDbReady(): Promise<void> {
  return dbReady;
}

// ─── 引擎懒初始化（按需加载，不占用启动时间） ────────────
let cachedScoring: ScoringEngine | null = null;
export async function getScoring() {
  const { ScoringEngine } = await import('@zh/scoring');
  if (!db) throw new Error(t('electron.scoringUnavailable'));
  if (!cachedScoring) cachedScoring = new ScoringEngine(db);
  return cachedScoring;
}

export function getDb(): ReturnType<DbConnection['connect']> {
  if (!db) throw new Error(t('electron.scoringUnavailable'));
  return db;
}

export interface SentinelRuntime {
  eventCenter: InstanceType<typeof import('@zh/sentinel').EventCenter>;
  fileMonitor: InstanceType<typeof import('@zh/sentinel').FileMonitor>;
  logCollector: InstanceType<typeof import('@zh/sentinel').LogCollector>;
  processMonitor: InstanceType<typeof import('@zh/sentinel').ProcessMonitor>;
}

let sentinelRuntime: SentinelRuntime | null = null;
export async function getSentinel(): Promise<SentinelRuntime> {
  if (sentinelRuntime) return sentinelRuntime;
  const { EventCenter, FileMonitor, LogCollector, ProcessMonitor, subscribeScopeViolations } =
    await import('@zh/sentinel');
  const eventCenter = new EventCenter();
  if (db) eventCenter.setDb(db);
  subscribeScopeViolations(eventBus, eventCenter);
  sentinelRuntime = {
    eventCenter,
    fileMonitor: new FileMonitor(eventCenter),
    logCollector: new LogCollector(eventCenter),
    processMonitor: new ProcessMonitor(eventCenter),
  };
  return sentinelRuntime;
}

/** 停止所有哨兵监控实例（文件监控 / 日志采集 / 进程监控） */
export function stopAllMonitoring(): void {
  if (sentinelRuntime) {
    sentinelRuntime.fileMonitor.stop();
    sentinelRuntime.logCollector.stop();
    sentinelRuntime.processMonitor.stop();
  }
}

/** 退出前停止哨兵监控（行为与 stopAllMonitoring 一致） */
export function shutdownSentinel(): void {
  stopAllMonitoring();
}

let evolveEngine: import('@zh/evolve').EvolveEngine | null = null;
export async function getEvolve(): Promise<import('@zh/evolve').EvolveEngine> {
  if (evolveEngine) return evolveEngine;
  const { EvolveEngine } = await import('@zh/evolve');
  evolveEngine = new EvolveEngine({
    dataFile: path.join(app.getPath('userData'), 'evolve-state.json'),
    clientId: 'zh-codeshield-desktop',
  });
  return evolveEngine;
}

/**
 * 向渲染进程发送流水线进度事件。
 * 实际扫盘在子进程完成，主进程仅转发进度，避免 macOS 彩球。
 */
export function sendProgress(stage: string, message: string, pct: number): void {
  mainWindow?.webContents.send('engine:pipeline:progress', { stage, message, progress: pct });
}
