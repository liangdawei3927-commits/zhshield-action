import { useT } from '../../i18n';
import { PrimaryButton } from '../ui/PrimaryButton';
import {
  ACTION_RUNNING_LABEL_KEY,
  toPureStatusLabel,
  type ActionRunningKey,
} from './domain-action-text';

export interface DomainActionButtonProps {
  /** 动作归属：决定运行态文案（唯一来源见 domain-action-text） */
  domain: ActionRunningKey;
  /** 空闲态文案（如「一键体检」「立即扫描」「开始盘点」） */
  label: string;
  loading?: boolean;
  /**
   * 任务已入队但还没真正开始（主进程并发槽被占）。
   *
   * 必须与 loading 分开：排队时若照旧显示「扫描中...」，用户无法区分"在跑但没进度"
   * 与"根本没开始"（实测最长可等数分钟）。排队位置不进按钮（220px 胶囊放不下），
   * 由进度条文案承担。
   */
  queued?: boolean;
  /**
   * 活跃任务是每日自动巡检发起的（task.origin === 'auto'）。
   * 忙态文案从「体检中/排队中」换成「自动巡检中/自动巡检排队中」：
   * 用户点一键体检撞上自动巡检时，看得到"系统正在自己检查"，而不是
   * 对着一个莫名的「排队中」怀疑应用卡死。
   */
  autoActive?: boolean;
  /**
   * 停止当前任务。传了才会在忙态把主按钮变成停止入口 —— 没传表示这个域没有
   * 可取消的执行器，不摆一个点了没反应的入口。
   */
  onCancel?: () => void;
  /** 已发出取消、等确认：显示「停止中…」并禁用 */
  stopping?: boolean;
  onClick?: () => void;
  className?: string;
}

/**
 * 全站唯一的「域主操作按钮」。
 *
 * 空态（健康环下面那个大按钮）与分类详情页顶部按钮**必须是同一个组件**：
 * 用同一套尺寸（220×56 胶囊，来自 PrimaryButton）、同一套文案来源。
 *
 * **停止与主按钮是同一颗按钮**（2026-10-25 用户明确要求）：
 * - 空闲：显示动作文案（一键体检 / 立即扫描…），点击=执行；
 * - 忙态：显示纯状态词（体检中… / 排队中…），**鼠标移上去换成「停止」**，
 *   点击=取消。不额外摆第二个按钮 —— 那会挤掉主按钮的视觉重心，也让十宫格
 *   布局不统一；
 * - 已发出取消：显示「停止中…」并禁用，防连点发出第二次取消。
 *
 * 关键实现约束：忙态**不能**把 `loading` 传给 PrimaryButton（BaseButton 会把
 * loading 转成 disabled，hover 出的「停止」就变成装饰、点不动）。所以只有
 * 「忙且没有 onCancel」才走 PrimaryButton 的 loading 分支。
 */
export function DomainActionButton({
  domain,
  label,
  loading = false,
  queued = false,
  autoActive = false,
  onCancel,
  stopping = false,
  onClick,
  className,
}: DomainActionButtonProps) {
  const t = useT();
  // 削成纯状态词：百分比/任务消息一律不进按钮（进度条才是它们的落点）
  const runningLabel = autoActive
    ? toPureStatusLabel(t('task.autoRunningShort', { defaultValue: '自动巡检中...' }))
    : toPureStatusLabel(t(ACTION_RUNNING_LABEL_KEY[domain]));
  // 排队同样是"纯状态词"：只报状态，不报位置（见 props.queued 注释）
  const queuedLabel = autoActive
    ? toPureStatusLabel(t('task.autoQueuedShort', { defaultValue: '自动巡检排队中...' }))
    : toPureStatusLabel(t('task.queuedShort', { defaultValue: '排队中...' }));
  const statusLabel = queued ? queuedLabel : runningLabel;
  const busy = loading || queued;

  /** 忙态可停：hover 换「停止」+ 点击取消 */
  const stoppable = busy && Boolean(onCancel) && !stopping;
  /** 忙态已在取消中：禁用防连点 */
  const cancelling = busy && Boolean(onCancel) && stopping;
  /** 忙且没有取消能力：维持原来的「禁用 + 只显示状态词」 */
  const busyWithoutCancel = busy && !onCancel;

  return (
    <PrimaryButton
      onClick={busy ? (stoppable ? onCancel : undefined) : onClick}
      // 只有「忙且不可停止」才交给 PrimaryButton 的 loading 分支（它会禁用按钮）
      loading={busyWithoutCancel}
      loadingLabel={statusLabel}
      disabled={cancelling || undefined}
      className={stoppable ? `group ${className ?? ''}`.trim() : className}
      data-domain={domain}
      data-stoppable={stoppable ? 'true' : undefined}
    >
      {busy ? (
        cancelling ? (
          <span data-action-text="stopping">{t('common.stopping')}</span>
        ) : (
          <>
            {/*
              两层文案常驻 DOM，由 CSS（group-hover）决定显示哪一层：
              纯 CSS 切换不引起重渲染，hover 进出也不会有状态抖动。
              静态渲染下两层都在 —— 测试据此断言「停止」确实挂在主按钮上。
            */}
            <span data-action-text="running" className="group-hover:hidden">
              {statusLabel}
            </span>
            <span data-action-text="stop" className="hidden group-hover:inline">
              {t('common.stop')}
            </span>
          </>
        )
      ) : (
        label
      )}
    </PrimaryButton>
  );
}
