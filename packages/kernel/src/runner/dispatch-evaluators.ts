// ─── 派发评估入口（原模块路径保留） ─────────────────────
// 各指令域实现已按功能拆分为同级模块，本文件保留原模块路径与全部原导出
// （re-export，符号与语义均不变），调用方（runner.ts）无需改动任何 import：
// - 共享辅助（toMessage / 硬超时 / errorResult 等）→ dispatch-shared.ts
// - check-list → dispatch-check-list.ts
// - tool-dispatch → dispatch-tool-scan.ts
// - scanner-dispatch / preset → dispatch-engine-scan.ts
// - tool-execution 审计日志 → tool-audit.ts（收敛审计负载构造）

export { DEFAULT_TOOL_SCAN_TIMEOUT_MS } from './dispatch-shared';
export { evalCheckList } from './dispatch-check-list';
export { evalScannerDispatch, evalPreset } from './dispatch-engine-scan';
export { evalToolDispatch } from './dispatch-tool-scan';
