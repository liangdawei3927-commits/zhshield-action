/** 内部事件稳定去重键：同项目+模块+标题+严重度在去重窗口内合并（防崩溃循环事件风暴） */
export function eventKey(
  projectId: string,
  module: string,
  title: string,
  severity: string,
): string {
  return `${projectId}|${module}|${title}|${severity}`;
}