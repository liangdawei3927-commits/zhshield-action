/**
 * 内核 4 工具域工具 ID（SOP 工具规则同步的本地工具集合）。
 *
 * 定义独立于此文件，供 capability-refs-reader 与 tool-rule-sync 共享，
 * 避免二者彼此反向 import 形成循环依赖。区别于 @zh/shared 的 17 值 ToolId。
 */
export type ToolId = 'semgrep' | 'trivy' | 'eslint' | 'dep-cruiser';
