import { useT } from '../i18n';
import { useGuardHooks, STATUS_LABELS, type GuardLevelInfo } from './guard-logic';
import { ResultCard } from '../components/ui/ResultCard';

export { GuardTable } from './guard-table-parts';
export { GuardHistory } from './guard-history-parts';

/** 三级拦截关卡卡片：L1 提交 / L2 推送 / L3 CI */
export function GuardLevels({ levels }: { levels: GuardLevelInfo[] }) {
  const t = useT();
  return (
    <div className="flex gap-4 mb-8">
      {levels.map((level) => {
        const st = STATUS_LABELS[level.status] ?? {
          textKey: 'page.guard.status.idle',
          color: 'rgb(var(--zh-muted))',
          bg: 'rgb(var(--zh-muted) / 0.08)',
        };
        return (
          <ResultCard key={level.level} variant="stats" className="flex-1">
            <div className="flex items-center gap-2 mb-2">
              <span
                className="px-2 py-0.5 rounded text-xs font-bold"
                style={{ background: st.bg, color: st.color }}
              >
                {level.level}
              </span>
              <span className="text-sm font-medium text-zh-ink-2">{t(level.labelKey)}</span>
            </div>
            <div className="text-2xl font-bold mt-2" style={{ color: st.color }}>
              {level.status === 'idle' ? '—' : level.blockingCount}
            </div>
            <div className="text-xs text-zh-muted mt-1">
              {level.status === 'idle'
                ? t('page.guard.status.idle')
                : t('page.guard.blockingCount', { count: level.blockingCount })}
            </div>
            {level.lastAt && (
              <div className="text-[11px] text-zh-muted mt-2">
                {t('page.guard.lastBlockAt', { time: new Date(level.lastAt).toLocaleString() })}
              </div>
            )}
          </ResultCard>
        );
      })}
    </div>
  );
}

/**
 * 门禁守护状态（git hooks）：状态型控件，不是「扫描」按钮。
 *
 * 「运行中」只在 pre-commit / pre-push 确实存在于 `.git/hooks` 时显示；
 * 未安装显示「未开启守护」，悬浮/点击切换为「开启守护」；已安装则悬浮显示「停止守护」。
 * 状态必须可验证——写死的「运行中」等于告诉用户门禁在守，实际门还开着。
 */
/** 钩子状态 → 展示字段（纯函数：把分支复杂度从组件里挪出来，组件只做排版） */
function hooksStatusView(params: {
  hasGitDir: boolean;
  stages: string[];
  loading: boolean;
  busy: boolean;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const { hasGitDir, stages, loading, busy, t } = params;
  const running = stages.length > 0;
  const canToggle = hasGitDir && !loading && !busy;
  const label = loading
    ? t('page.guard.hooks.loading')
    : busy
      ? t('page.guard.hooks.working')
      : running
        ? t('page.guard.hooks.running')
        : t('page.guard.hooks.off');
  const hoverLabel = running ? t('page.guard.hooks.stop') : t('page.guard.hooks.enable');
  const title = hasGitDir ? hoverLabel : t('page.guard.hooks.notGit');
  const footnote = !hasGitDir
    ? t('page.guard.hooks.notGit')
    : running
      ? t('page.guard.hooks.installed', { stages: stages.join(' · ') })
      : t('page.guard.hooks.hint');
  const dotColor = running ? 'rgb(var(--zh-success))' : 'rgb(var(--zh-muted))';
  const buttonStyle = {
    borderColor: running ? 'rgb(var(--zh-success) / 0.45)' : 'rgb(var(--zh-line))',
    color: running ? 'rgb(var(--zh-success))' : 'rgb(var(--zh-ink-2))',
    background: running ? 'rgb(var(--zh-success) / 0.08)' : 'rgb(var(--zh-panel))',
  };
  return { running, canToggle, label, hoverLabel, title, footnote, dotColor, buttonStyle };
}

/**
 * 检查项卡头部的一行守护状态（对齐备份中心「定时备份设置」的嵌卡片头做法）：
 * 左侧胶囊可点击开启/停止，右侧跟着安装明细与上次判定，不再单独占一张卡片。
 */
export function GuardHooksStatus({
  projectPath,
  lastJudgedAt,
}: {
  projectPath: string;
  lastJudgedAt?: string;
}) {
  const t = useT();
  const { hasGitDir, installed, loading, busy, toggle } = useGuardHooks(projectPath);
  const stages = installed.filter((h) => h === 'pre-commit' || h === 'pre-push');
  const view = hooksStatusView({ hasGitDir, stages, loading, busy, t });

  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-3 border-b border-zh-line"
      data-testid="guard-hooks-status"
    >
      <span className="text-xs text-zh-muted">
        {t('page.guard.hooks.label', { defaultValue: '守护状态' })}
      </span>
      <button
        type="button"
        onClick={() => void toggle()}
        disabled={!view.canToggle}
        title={view.title}
        aria-label={view.title}
        className="group inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60"
        style={view.buttonStyle}
      >
        <span className="w-1.5 h-1.5 rounded-full" style={{ background: view.dotColor }} />
        <span className={view.canToggle ? 'group-hover:hidden' : undefined}>{view.label}</span>
        {view.canToggle && <span className="hidden group-hover:inline">{view.hoverLabel}</span>}
      </button>
      <span className="text-xs text-zh-muted">{view.footnote}</span>
      {view.running && lastJudgedAt && (
        <span className="text-xs text-zh-muted">
          {t('page.guard.hooks.lastJudged', {
            time: new Date(lastJudgedAt).toLocaleString(),
          })}
        </span>
      )}
    </div>
  );
}

