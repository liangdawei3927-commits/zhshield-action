/**
 * Pipeline 子进程入口
 *
 * 在独立 Node 进程中执行 SOP 流水线，避免 Electron 主进程
 * （CrBrowserMain）被同步扫盘阻塞，导致 macOS 彩球 / SIGTRAP 崩溃。
 *
 * 启动方式：child_process.fork(..., { env: { ELECTRON_RUN_AS_NODE: '1' } })
 *
 * 职责拆分：流水线编排见 pipeline-sop，单引擎任务见 pipeline-jobs，
 * 报告构建见 pipeline-report，IPC 发送见 pipeline-ipc。
 */
import { initI18n, resolveLanguage } from '@zh/i18n';
import { createReport } from '@zh/pipeline';
import { serializePipelineReport, type PipelineWorkerInbound } from './pipeline-protocol';
import { progress, send } from './pipeline-ipc';
import { attachSummary } from './pipeline-report';
import { runSopJob, runFullPipelineJob } from './pipeline-sop';
import {
  runRefactorJob,
  runGuardJob,
  runInspectJob,
  runSecurityJob,
  runGarbageCleanJob,
  runGarbageRestoreJob,
  runPerformanceJob,
} from './pipeline-jobs';

// 子进程独立 i18n 实例：语言由主进程 fork 时通过 LNG 环境变量传入
initI18n({ lng: resolveLanguage(process.env.LNG ?? null, null).value });

async function runPipeline(
  id: string,
  projectPath: string,
  options?: { dryRun?: boolean; sop?: boolean; guardEnabled?: boolean },
): Promise<void> {
  const { PipelineRunner } = await import('@zh/pipeline');
  const runner = new PipelineRunner(projectPath);
  const opts = options ?? {};

  try {
    progress(id, 'sop', '加载体检规则…', 0.05);
    await runner.loadSopRules();

    const guardEnabled = opts.guardEnabled !== false;

    if (opts.sop) {
      await runSopJob(id, runner, opts.dryRun, guardEnabled);
    } else {
      await runFullPipelineJob(id, runner, opts.dryRun, guardEnabled);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[pipeline-worker] 流水线异常:', err instanceof Error ? err.stack || message : message);
    const report = attachSummary(createReport({
      stage: 'failed',
      passed: false,
      error: message,
    }));
    send({ type: 'result', id, report: serializePipelineReport(report) });
  } finally {
    await runner.destroy().catch(() => undefined);
  }
}

/** 并发执行收到的所有任务：并发度由主进程 TaskManager 控制（同时最多 MAX_CONCURRENT 个） */
process.on('message', (raw: PipelineWorkerInbound) => {
  if (!raw || typeof raw !== 'object') return;

  switch (raw.type) {
    case 'run':
      void runPipeline(raw.id, raw.projectPath, raw.options);
      break;
    case 'runRefactor':
      void runRefactorJob(raw.id, raw.projectPath);
      break;
    case 'runGuard':
      void runGuardJob(raw.id, raw.projectPath, raw.options);
      break;
    case 'runInspect':
      void runInspectJob(raw.id, raw.projectPath);
      break;
    case 'runSecurity':
      void runSecurityJob(raw.id, raw.projectPath);
      break;
    case 'runGarbageClean':
      void runGarbageCleanJob(raw.id, raw.projectPath, raw.items);
      break;
    case 'runGarbageRestore':
      void runGarbageRestoreJob(raw.id, raw.projectPath, raw.batchId);
      break;
    case 'runPerformance':
      void runPerformanceJob(raw.id, raw.projectPath);
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
