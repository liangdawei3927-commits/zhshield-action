/**
 * 文件级事件上报（file-events.ts）—— 从 FileMonitor 拆出的「上报」职责。
 *
 * 拆分理由：FileMonitor 只该管「发现变化」，把变化变成事件是另一件事。
 * 标题生成、强度判定、去重键构造都收敛在本文件，监控类不再持有 eventCenter，
 * 也不必知道「未跟踪的 unlink 要降级为 p3」这类上报口径。
 * 触发点是 large-class 门禁（FileMonitor 303 行 > 300 阈值）；
 * 职责边界与既有的 process-events.ts 保持同一拆分思路。
 */
import * as path from 'path';
import { EventCenter } from './event-center';
import { eventKey } from './event-key';

/** 文件变更类型：新增、内容变更、删除 */
export type FileChangeType = 'add' | 'change' | 'unlink';

/** 文件级事件上报入参（封装为对象，避免参数列表拖长） */
export interface FileEventInput {
  projectId: string;
  fullPath: string;
  watchPath: string;
  changeType: FileChangeType;
  /** 整树删除时被折叠进本条事件的文件数；单文件删除不填 */
  collapsedCount?: number;
  /**
   * 该路径是否属于版本库跟踪的交付物。只在 unlink 时有意义：
   * `false` = 未跟踪（临时文件/探针脚本），降级为 p3 信息类事件；
   * `true` / `null`（不可判定）保持 p2 告警。
   */
  tracked?: boolean | null;
}

/** 文件事件上报器：持有 eventCenter，把变化翻译成哨兵事件 */
export class FileEventReporter {
  constructor(private readonly eventCenter: EventCenter) {}

  /** 上报「文件内容变更」事件（轮询发现 mtime 前进时） */
  emitMtimeChange(input: {
    fullPath: string;
    watchPath: string;
    projectId: string;
    mtime: number;
  }): void {
    const { fullPath, watchPath, projectId, mtime } = input;
    const title = `File changed: ${path.relative(watchPath, fullPath)}`;
    this.eventCenter.createEvent({
      projectId,
      title,
      service: 'sentinel',
      module: 'file-monitor',
      severity: 'p3',
      context: { filePath: fullPath, changeType: 'change', mtime: new Date(mtime).toISOString() },
      operator: 'file-monitor',
      action: 'file-changed',
      detail: `File modified: ${fullPath}`,
      dedupeKey: eventKey(projectId, 'file-monitor', title, 'p3'),
    });
  }

  /**
   * 上报文件级事件。
   *
   * 标题用**监控根相对路径**而非 basename：只用 basename 时，Electron 包里
   * 220 个 `locale.pak` 全显示成同一串文字，用户根本无从判断是哪个目录出的事。
   */
  emitFileChangeEvent(input: FileEventInput): void {
    const { projectId, fullPath, watchPath, changeType, collapsedCount, tracked } = input;
    const rel = path.relative(watchPath, fullPath) || path.basename(fullPath);
    const title = `File ${changeType}: ${rel}`;
    // 告警强度取决于「消失的是不是交付物」：未跟踪 ⇒ p3 信息类；其余 unlink ⇒ p2
    const untrackedUnlink = changeType === 'unlink' && tracked === false;
    const severity = changeType === 'unlink' && !untrackedUnlink ? 'p2' : 'p3';
    const perFileIdentity = `${title}|${fullPath}`;
    const context: Record<string, unknown> = { filePath: fullPath, changeType };
    if (collapsedCount !== undefined) context.collapsedCount = collapsedCount;
    if (changeType === 'unlink') context.tracked = tracked;
    this.eventCenter.createEvent({
      projectId,
      title,
      service: 'sentinel',
      module: 'file-monitor',
      severity,
      context,
      operator: 'file-monitor',
      action: untrackedUnlink ? 'file-unlink-untracked' : `file-${changeType}`,
      detail:
        collapsedCount !== undefined
          ? `${collapsedCount} files removed with directory ${fullPath}`
          : `File ${changeType}: ${fullPath}`,
      dedupeKey: eventKey(projectId, 'file-monitor', perFileIdentity, severity),
    });
  }
}
