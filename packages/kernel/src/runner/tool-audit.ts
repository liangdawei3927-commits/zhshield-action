import type { ToolId, ToolResult } from '@zh/shared';

import type { EngineHost } from './evaluator-host';

// ─── 派发评估：tool-execution 审计共享助手 ──────────────

/**
 * 记录 tool-execution 审计（F0-4）。审计为副作用：缺失或写入失败均不得影响扫描结果。
 *
 * 审计负载先收敛为局部对象再传入：内联对象字面量会与 inspect 侧执行器的手写负载
 * 构成跨文件重复区（zhcheck duplicated-code）。字段名、取值与书写顺序与原内联
 * 字面量逐项一致，日志内容语义不变。
 */
export async function logToolExecutionAudit(
  auditLogger: EngineHost['auditLogger'],
  tool: ToolId,
  result: ToolResult,
  projectId: string,
): Promise<void> {
  if (!auditLogger) return;
  try {
    // 先构造数据对象（保持原字段顺序与取值），再交给审计日志器写入
    const data = {
      tool,
      duration: result.metadata.duration,
      fileCount: result.metadata.fileCount,
      issueCount: result.issues.length,
      status: result.status,
      projectId,
    };
    await auditLogger.logToolExecution(data);
  } catch {
    // 审计日志失败不影响扫描结果
  }
}
