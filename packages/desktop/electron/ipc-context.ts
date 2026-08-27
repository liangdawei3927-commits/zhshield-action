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
  EventBus, SopRegistry, SopCacheManager,
  WisdomBrainSync, ToolRuleSync, ExperienceReporter,
  buildDefaultToolRuleConfigs, resolveApiBase, resolveSopBase,
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
export const API_BASE = resolveApiBase(process.env.ZH_API_BASE || process.env.VITE_API_BASE);
export const eventBus = new EventBus();
export const sopRegistry = new SopRegistry(eventBus);

const SOP_BASE = resolveSopBase(API_BASE);

let cachedSopPublicKey: string | null | undefined;
/** 解析 SOP 规则包验签公钥：优先环境变量 ZH_SOP_PUBLIC_KEY，否则从服务端 /public-key 发现 */
export async function resolveSopPublicKey(): Promise<string | null> {
  if (cachedSopPublicKey !== undefined) return cachedSopPublicKey;

  const pinned = process.env.ZH_SOP_PUBLIC_KEY;
  if (pinned) {
    cachedSopPublicKey = pinned;
    return pinned;
  }

  try {
    const res = await fetch(`${SOP_BASE}/public-key`, { signal: AbortSignal.timeout(10_000) });
    if (res.ok) {
      const data = (await res.json()) as { publicKey?: string };
      cachedSopPublicKey = data.publicKey ?? null;
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
});

/** 智汇大脑协同：工具规则下发 + 经验回写 */
export const wisdomBrainSync = new WisdomBrainSync({
  toolRuleSync: new ToolRuleSync(buildDefaultToolRuleConfigs(API_BASE)),
  experienceReporter: new ExperienceReporter({ remoteUrl: `${API_BASE}/experience` }),
});

// ─── 治理引擎依赖：DB ──────────────────────────────────────
// DB 初始化失败不应阻断主进程启动 — 降级为无持久化模式（与 server 端 SopService/SentinelService 一致）。
// HTTP 模式下 renderer 走服务端，不依赖本地 DB；IPC 模式下评分/哨兵持久化退化为内存态。
const dbPath = path.join(app.getPath('userData'), 'zh-codeshield.db');
const dbConn = new DbConnection({ dbPath });
let db: ReturnType<DbConnection['connect']> | null = null;
try {
  db = dbConn.connect();
  const migrationsDir = path.resolve(__dirname, VITE_DEV_SERVER_URL ? '../../db/migrations' : 'resources/db/migrations');
  if (fs.existsSync(migrationsDir)) {
    dbConn.migrate(migrationsDir);
  }
} catch (err) {
  console.error(
    `[ipc-context] DB 初始化失败，降级为无持久化模式: ${err instanceof Error ? err.message : String(err)}`,
  );
  db = null;
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
  const { EventCenter, FileMonitor, LogCollector, ProcessMonitor, subscribeScopeViolations } = await import('@zh/sentinel');
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
