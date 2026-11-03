/**
 * 异步扫描域页面共用的状态/操作 props。
 *
 * 守卫 / 体检 / 垃圾 / 安全 / 依赖 / 技术债 / 重构等域的报告视图此前各自重复声明
 * 同一组字段（loading / progress / statusMessage / queued / onCancel / stopping），
 * 仅注释里的域名词不同——属结构性重复。抽到此处统一维护：新增进度相关字段只改一处，
 * 各视图以 `extends AsyncScanViewProps` 复用。
 *
 * 注：命名已统一 —— 全部域一律用 `loading`（运行态）/ `statusMessage`（进度文案）。
 * 历史上重构域用 `scanning`、依赖 / 技术债域用 `progressMessage`，两者已于 2026-11-03
 * 收敛到本接口的字段名（`scanning` → `loading`，`progressMessage` → `statusMessage`）。
 */

/**
 * 扫描运行态的**操作子集**：报告视图（检查结果态）只需要这些字段。
 *
 * 报告态不再渲染页内进度条（2026-10-26 下线，ReportShell 已移除相关 props），
 * 因此 `progress` / `statusMessage` 对报告视图是死字段 —— 由域空态视图
 * （PageShell 一路）独占使用。故把两者拆开：
 *   · `AsyncScanActionProps` —— 报告视图用（loading / queued / onCancel / stopping）
 *   · `AsyncScanViewProps`    —— 域空态视图用（在上者基础上加 progress / statusMessage）
 *
 * 这样报告视图不必再接收用不到的进度字段，调用点少传两个 prop，也不会
 * 出现「传了却没渲染」的误导性字段。
 */
export interface AsyncScanActionProps {
  /** 扫描运行中（按钮显示运行态文案） */
  loading: boolean;
  /** 排队中：按钮显示「排队中…」而不是「扫描 / 检查中…」 */
  queued?: boolean;
  /** 停止本次扫描（运行 / 排队时按钮旁出现「停止」） */
  onCancel: () => void;
  /** 已发出取消、等确认 */
  stopping: boolean;
}

/** 域空态（PageShell 一路）用的完整扫描状态：操作子集 + 进度数值 + 进度文案 */
export interface AsyncScanViewProps extends AsyncScanActionProps {
  /** 扫描进度 0..1 */
  progress: number;
  /** 扫描进度文案（如「正在检查…」） */
  statusMessage: string;
}
