/**
 * 测试专用观测 IPC（ipc/e2e-observation.ts）
 *
 * 仅 e2e 可触发（process.env.E2E === '1' 门控，见 main.ts 注册处），
 * 不注册到对外生产 API 面。用途：让 e2e 删除全链用例能观测主进程内存态——
 * ① 5 表软删计数（getDb 在主进程内存态，渲染进程无法直接拿句柄）
 * ② cachedProfile 归属项目路径（null = 已清空）
 * ③ 预置 5 表孤儿行（复用 @zh/db 写函数，与桌面写入键控 project_id = projectPath 对齐）
 */
import { ipcMain } from 'electron';
import {
  createSentinelEvent,
  saveDebtAction,
  saveDebtSnapshot,
  saveScanResult,
  saveScore,
} from '@zh/db';
import { getCachedProfileProjectPath, getDb, setCachedProfile, whenDbReady } from '../ipc-context';

/** 与 queries.ts PROJECT_DATA_TABLES 对齐的 5 张表 */
const PROJECT_DATA_TABLES = [
  'scores',
  'scanning_results',
  'debt_actions',
  'debt_snapshots',
  'sentinel_events',
] as const;

/** 统计某 project_id 在 5 表中已软删（deleted_at IS NOT NULL）的行数（逐表） */
function countSoftDeleted(db: ReturnType<typeof getDb>, projectId: string): Record<string, number> {
  const counts: Record<string, number> = {};
  const stmts = new Map(
    PROJECT_DATA_TABLES.map((table) => [
      table,
      db.prepare(
        `SELECT COUNT(*) AS c FROM ${table} WHERE project_id = ? AND deleted_at IS NOT NULL`,
      ),
    ]),
  );
  for (const table of PROJECT_DATA_TABLES) {
    const row = stmts.get(table)!.get(projectId) as { c: number };
    counts[table] = row.c;
  }
  return counts;
}

/** 统计某 project_id 在 5 表中的总行数（含未软删，供预置断言对照） */
function countTotal(db: ReturnType<typeof getDb>, projectId: string): Record<string, number> {
  const counts: Record<string, number> = {};
  const stmts = new Map(
    PROJECT_DATA_TABLES.map((table) => [
      table,
      db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE project_id = ?`),
    ]),
  );
  for (const table of PROJECT_DATA_TABLES) {
    const row = stmts.get(table)!.get(projectId) as { c: number };
    counts[table] = row.c;
  }
  return counts;
}

/** 预置 5 表孤儿行（project_id = projectPath，与桌面写入键控对齐） */
function seedOrphanRows(projectPath: string): void {
  const db = getDb();
  const now = new Date();
  saveScore(db, {
    projectId: projectPath,
    overall: 70,
    grade: 'C',
    dimensions: '{}',
    trend: 'stable',
  });
  saveScanResult(db, { projectId: projectPath, source: 'eslint', passed: true, summary: 'OK' });
  saveDebtAction(db, {
    projectId: projectPath,
    actionId: 'e2e-debt-action-1',
    status: 'pending',
    module: 'm',
    category: 'c',
    issueIds: ['i1'],
    interestScore: 1,
    principalEstimate: 2,
    roi: 3,
  });
  saveDebtSnapshot(db, { projectId: projectPath, debtIndex: 5 });
  createSentinelEvent(db, {
    id: 'e2e-sentinel-1',
    projectId: projectPath,
    timestamp: now,
    dedupeKey: 'e2e-dedupe-1',
    title: 'Warning',
    service: 'api',
    module: 'core',
    severity: 'p2',
    status: 'detected',
    validation: '{}',
    context: '{}',
    history: '[]',
    occurrenceCount: 1,
    firstSeen: now,
    lastSeen: now,
  });
}

/** 注册测试专用观测 IPC（仅 E2E 门控下由 main.ts 调用） */
export function registerE2eObservationIpc(): void {
  ipcMain.handle(
    'e2e:countSoftDeletedData',
    (_event, projectPath: string): Record<string, number> => {
      return countSoftDeleted(getDb(), projectPath);
    },
  );

  ipcMain.handle('e2e:countTotalData', (_event, projectPath: string): Record<string, number> => {
    return countTotal(getDb(), projectPath);
  });

  ipcMain.handle('e2e:getCachedProfileProjectPath', (): string | null => {
    return getCachedProfileProjectPath();
  });

  ipcMain.handle('e2e:setCachedProfile', (_event, projectPath: string): void => {
    // 预置画像缓存归属 demo 项目，供删除后断言清空（null）。
    // language 用 'typescript'（真实管线 EXTENSION_LANGUAGES 映射值），与 isToolInScope 匹配。
    setCachedProfile({ framework: 'node', language: 'typescript', features: [] }, projectPath);
  });

  ipcMain.handle('e2e:seedOrphanData', async (_event, projectPath: string): Promise<void> => {
    // 冷启动竞态：迁移在微任务中异步执行（ipc-context dbReady），
    // 立即触发本 IPC 时 schema 可能未建好，须先 await 迁移完成。
    await whenDbReady();
    seedOrphanRows(projectPath);
  });
}
