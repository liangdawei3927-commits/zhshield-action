/**
 * Pipeline 子进程入口
 *
 * 在独立 Node 进程中执行 SOP 流水线，避免 Electron 主进程
 * （CrBrowserMain）被同步扫盘阻塞，导致 macOS 彩球 / SIGTRAP 崩溃。
 *
 * 启动方式：child_process.fork(..., { env: { ELECTRON_RUN_AS_NODE: '1' } })
 *
 * 职责拆分：runner 装配见 pipeline-runner-factory，流水线编排见 pipeline-sop，
 * 单引擎任务见 pipeline-jobs，报告构建见 pipeline-report，IPC 发送见 pipeline-ipc。
 */
import { initI18n, resolveLanguage } from '@zh/i18n';
import { createReport, type PipelineRunner } from '@zh/pipeline';
import { serializePipelineReport, type PipelineWorkerInbound } from './pipeline-protocol';
import { progress, send } from './pipeline-ipc';
import { attachSummary } from './pipeline-report';
import { createLoadedRunner } from './pipeline-runner-factory';
import { runSopJob, runFullPipelineJob } from './pipeline-sop';
import {
  runRefactorJob,
  runGuardJob,
  runSecurityJob,
  runGarbageScanJob,
  runGarbageCleanJob,
  runGarbageRestoreJob,
  runPerformanceJob,
} from './pipeline-jobs';

// 子进程独立 i18n 实例：语言由主进程 fork 时通过 LNG 环境变量传入
initI18n({ lng: resolveLanguage(process.env.LNG ?? null, null).value });

interface RunningJob {
  id: string;
  controller: AbortController;
  cancelAt?: number;
}

const runningJobs = new Map<string, RunningJob>();

// 按运行模式分派到 SOP 或完整流水线 Job
async function runPipelineByMode(
  id: string,
  runner: PipelineRunner,
  opts: { dryRun?: boolean; sop?: boolean; guardEnabled: boolean },
): Promise<void> {
  if (opts.sop) {
    await runSopJob(id, runner, opts.dryRun, opts.guardEnabled);
  } else {
    await runFullPipelineJob(id, runner, opts.dryRun, opts.guardEnabled);
  }
}

async function runPipeline(
  id: string,
  projectPath: string,
  options?: { dryRun?: boolean; sop?: boolean; guardEnabled?: boolean },
): Promise<void> {
  const opts = options ?? { guardEnabled: true };
  try {
    progress(id, 'sop', '加载体检规则…', 0.05);
    // 规则装载同样收敛到装配工厂：只读内置模板而漏掉云同步规则，等于又造出
    // 「内置口径 vs 云端口径」的第二处分叉。
    const { runner, syncedRules } = await createLoadedRunner(projectPath);
    progress(
      id,
      'sop',
      syncedRules > 0 ? `同步规则已加载 ${syncedRules} 条` : '同步缓存不可用，使用内置模板',
      0.06,
    );
    try {
      await runPipelineByMode(id, runner, {
        dryRun: opts.dryRun,
        sop: opts.sop,
        guardEnabled: opts.guardEnabled !== false,
      });
    } finally {
      await runner.destroy().catch(() => undefined);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      '[pipeline-worker] 流水线异常:',
      err instanceof Error ? err.stack || message : message,
    );
    const report = attachSummary(createReport({ stage: 'failed', passed: false, error: message }));
    send({ type: 'result', id, report: serializePipelineReport(report) });
  }
}

/** 并发执行收到的所有任务：并发度由主进程 TaskManager 控制（同时最多 MAX_CONCURRENT 个） */
function wrapJob(id: string, fn: (ctrl: AbortController) => Promise<void>): void {
  const ctrl = new AbortController();
  runningJobs.set(id, { id, controller: ctrl });
  void fn(ctrl).finally(() => {
    runningJobs.delete(id);
  });
}

process.on('message', (raw: PipelineWorkerInbound) => {
  if (!raw || typeof raw !== 'object') return;

  switch (raw.type) {
    case 'cancel':
      if (raw.id) {
        const j = runningJobs.get(raw.id);
        if (j) {
          j.cancelAt = Date.now();
          j.controller.abort();
        }
      }
      break;
    case 'run':
      wrapJob(raw.id, async () => {
        await runPipeline(raw.id, raw.projectPath, raw.options);
      });
      break;
    case 'runRefactor':
      wrapJob(raw.id, async () => {
        await runRefactorJob(raw.id, raw.projectPath);
      });
      break;
    case 'runGuard':
      wrapJob(raw.id, async () => {
        await runGuardJob(raw.id, raw.projectPath, raw.options);
      });
      break;
    case 'runSecurity':
      wrapJob(raw.id, async () => {
        await runSecurityJob(raw.id, raw.projectPath);
      });
      break;
    case 'runGarbageScan':
      wrapJob(raw.id, async () => {
        await runGarbageScanJob(raw.id, raw.projectPath);
      });
      break;
    case 'runGarbageClean':
      wrapJob(raw.id, async () => {
        await runGarbageCleanJob(raw.id, raw.projectPath, raw.items);
      });
      break;
    case 'runGarbageRestore':
      wrapJob(raw.id, async () => {
        await runGarbageRestoreJob(raw.id, raw.projectPath, raw.batchId);
      });
      break;
    case 'runPerformance':
      wrapJob(raw.id, async () => {
        await runPerformanceJob(raw.id, raw.projectPath);
      });
      break;
    default:
      break;
  }
});

process.on('uncaughtException', (err) => {
  console.error('[pipeline-worker] uncaughtException:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[pipeline-worker] unhandledRejection:', reason);
});

send({ type: 'ready' });
