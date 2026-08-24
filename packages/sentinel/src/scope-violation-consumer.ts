// ─── 工具越界事件消费（F5-2）────────────────────────────

import type { EventBus } from '@zh/kernel';
import type { ScopeViolationEvent } from '@zh/shared';
import type { EventCenter } from './event-center';

/** 内核事件总线上工具越界事件的通道名（与 GovernanceEvent.type / pipeline 桥接一致） */
export const SCOPE_VIOLATION_EVENT = 'tool:scope-violation';

/**
 * 订阅内核 EventBus 上的工具越界事件，转入 EventCenter 告警流（warn-only 告警，不阻断）。
 * 返回取消订阅函数。
 */
export function subscribeScopeViolations(bus: EventBus, center: EventCenter): () => void {
  return bus.on<ScopeViolationEvent>(SCOPE_VIOLATION_EVENT, (payload) => {
    center.createEvent({
      projectId: payload.projectId,
      title: `工具越界访问: ${payload.tool}`,
      service: payload.tool,
      module: 'tool-adapter',
      severity: 'p3',
      context: { kind: 'tool-scope-violation', file: payload.file, reason: payload.reason },
      operator: 'sentinel',
      action: 'scope-violation-received',
      detail: `${payload.tool} 访问边界外文件 ${payload.file}（${payload.reason}）`,
    });
  });
}
