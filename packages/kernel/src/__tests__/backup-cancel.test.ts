/**
 * 备份取消语义（backup-cancel.test.ts）
 *
 * 用户诉求（2026-10-25）：备份中心「想停止，停止不了」。
 *
 * kernel 的备份链路（扫描 → 复制/打包 → 落盘）**早已支持 abortSignal**，但没有任何
 * 调用方传过它 ⇒ 用户点下「一键备份」就只能等它跑完。本测试锁的是补上接缝后的语义：
 *
 * 1. 已取消：不启动任何子备份，`overallStatus='cancelled'`（不是 'failed' —— 用户
 *    主动停止与备份失败是两件事，混为一谈会让历史记录里躺着一条假失败）；
 * 2. 取消**不落记录**：没跑完的备份不构成一次备份，不该出现在记录列表与评分口径里；
 * 3. 取消**不发 FAILED**：否则 UI 会弹「备份失败」，用户刚点的「停止」被报成错误。
 */

import { describe, expect, it, vi } from 'vitest';
import { BackupOrchestrator } from '../backup/orchestrator';
import { LocalBackup } from '../backup/local-backup';
import { GitHubBackup } from '../backup/github-backup';
import { BACKUP_EVENTS } from '../backup/types';

/** 记录型 eventBus：断言「取消时不发 FAILED」必须有可观测的事件轨迹 */
function createRecordingBus(): { emit: ReturnType<typeof vi.fn>; events: string[] } {
  const events: string[] = [];
  const emit = vi.fn(async (event: string) => {
    events.push(event);
  });
  return { emit, events };
}

function orchestratorWith(bus: ReturnType<typeof createRecordingBus>): {
  orchestrator: BackupOrchestrator;
  localBackup: LocalBackup;
} {
  const localBackup = new LocalBackup();
  const orchestrator = new BackupOrchestrator({
    githubBackup: new GitHubBackup(),
    localBackup,
    eventBus: { emit: bus.emit },
  });
  return { orchestrator, localBackup };
}

describe('备份取消', () => {
  it('已取消时不启动任何子备份，overallStatus = cancelled（不是 failed）', async () => {
    const bus = createRecordingBus();
    const { orchestrator, localBackup } = orchestratorWith(bus);
    const run = vi.spyOn(localBackup, 'backup');

    const controller = new AbortController();
    controller.abort();
    const result = await orchestrator.execute({
      projectId: 'test-project',
      projectPath: '/mock/path',
      abortSignal: controller.signal,
    });

    // 真阳性：子备份被真正跳过（不是"跑了但结果被丢弃"）
    expect(run).not.toHaveBeenCalled();
    expect(result.overallStatus).toBe('cancelled');
  });

  it('取消后不落记录：不把用户主动停止记成一次失败备份', async () => {
    const bus = createRecordingBus();
    const { orchestrator } = orchestratorWith(bus);

    const controller = new AbortController();
    controller.abort();
    await orchestrator.execute({
      projectId: 'test-project',
      projectPath: '/mock/path',
      abortSignal: controller.signal,
    });

    expect(orchestrator.getRecords('test-project')).toHaveLength(0);
  });

  it('取消时不发 FAILED 事件（UI 不该弹「备份失败」）', async () => {
    const bus = createRecordingBus();
    const { orchestrator } = orchestratorWith(bus);

    const controller = new AbortController();
    controller.abort();
    await orchestrator.execute({
      projectId: 'test-project',
      projectPath: '/mock/path',
      abortSignal: controller.signal,
    });

    expect(bus.events).toContain(BACKUP_EVENTS.STARTED);
    expect(bus.events).not.toContain(BACKUP_EVENTS.FAILED);
    expect(bus.events).not.toContain(BACKUP_EVENTS.COMPLETED);
  });

  it('未取消时行为不变：仍落记录并按子结果出 status（防止取消逻辑误伤正常路径）', async () => {
    const bus = createRecordingBus();
    const { orchestrator, localBackup } = orchestratorWith(bus);
    localBackup.backup = async () => ({
      type: 'local',
      success: true,
      backupPath: '/tmp/backup',
      size: 10,
      fileCount: 1,
    });

    const result = await orchestrator.execute({
      projectId: 'test-project',
      projectPath: '/mock/path',
      abortSignal: new AbortController().signal,
    });

    expect(result.overallStatus).toBe('success');
    expect(orchestrator.getRecords('test-project')).toHaveLength(1);
    expect(bus.events).toContain(BACKUP_EVENTS.COMPLETED);
  });
});
