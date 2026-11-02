/**
 * 异步扫描域页面「报告视图」共用的状态/操作 props。
 *
 * 守卫 / 体检 / 垃圾 / 安全等域的报告视图此前各自重复声明同一组字段
 * （loading / progress / statusMessage / queued / onCancel / stopping），
 * 仅注释里的域名词不同——属结构性重复。抽到此处统一维护：新增进度相关字段只改一处，
 * 各视图以 `extends AsyncScanViewProps` 复用。
 *
 * 注：重构域用 `scanning` 而非 `loading`、依赖 / 技术债域用 `progressMessage` 而非
 * `statusMessage`，命名尚未统一，暂不纳入本接口（列入后续命名对齐项）。
 */
export interface AsyncScanViewProps {
  loading: boolean;
  progress: number;
  /** 扫描进度文案（如「正在检查…」），与旧名 progressMessage 等价 */
  statusMessage: string;
  /** 排队中：按钮显示「排队中…」而不是「扫描 / 检查中…」 */
  queued?: boolean;
  /** 停止本次扫描（运行 / 排队时按钮旁出现「停止」） */
  onCancel: () => void;
  /** 已发出取消、等确认 */
  stopping: boolean;
}
