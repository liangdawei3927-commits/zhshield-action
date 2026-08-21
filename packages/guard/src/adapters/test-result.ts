/** 测试执行结果：命令输出解析（或文件系统兜底）得出的测试计数与失败明细 */
export interface TestResult {
  command: string;
  totalTests: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  details: string[];
  /** 输出中解析不到测试计数，由文件系统扫描兜底得出的结果（测试存在但运行结果未知） */
  unresolved?: boolean;
}
