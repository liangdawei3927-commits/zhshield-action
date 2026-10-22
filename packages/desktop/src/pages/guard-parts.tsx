import { useState, useEffect, useCallback, type Dispatch, type SetStateAction } from 'react';
import { useT } from '../i18n';
import { STATUS_LABELS, type GuardLevelInfo } from './guard-logic';
import { ResultCard } from '../components/ui/ResultCard';
import { readGuardConfig, writeGuardConfig } from '../services/engineApi';

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

function Toggle({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`w-10 h-6 rounded-full relative cursor-pointer border-none transition-colors ${
        enabled ? 'bg-brand-500' : 'bg-zh-line'
      }`}
    >
      <div
        className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${
          enabled ? 'right-0.5' : 'left-0.5'
        }`}
      />
    </button>
  );
}

function ConfigRow({
  title,
  desc,
  enabled,
  onToggle,
}: {
  title: string;
  desc: string;
  enabled: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-center justify-between p-3 rounded-lg bg-zh-panel">
      <div>
        <div className="text-sm font-medium text-zh-ink-2">{title}</div>
        <div className="text-xs text-zh-muted">{desc}</div>
      </div>
      <Toggle enabled={enabled} onToggle={onToggle} />
    </div>
  );
}

/** 门禁配置状态：读取 guard-config.json + 本地编辑 */
function useGuardConfigState(): {
  preCommit: boolean;
  setPreCommit: Dispatch<SetStateAction<boolean>>;
  prePush: boolean;
  setPrePush: Dispatch<SetStateAction<boolean>>;
  blockCritical: boolean;
  setBlockCritical: Dispatch<SetStateAction<boolean>>;
  enabled: boolean;
  loading: boolean;
} {
  const [preCommit, setPreCommit] = useState(true);
  const [prePush, setPrePush] = useState(true);
  const [blockCritical, setBlockCritical] = useState(true);
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    readGuardConfig().then((config) => {
      if (!cancelled) {
        setPreCommit(config.preCommit);
        setPrePush(config.prePush);
        setBlockCritical(config.blockOnCritical);
        setEnabled(config.enabled);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return {
    preCommit,
    setPreCommit,
    prePush,
    setPrePush,
    blockCritical,
    setBlockCritical,
    enabled,
    loading,
  };
}

/** 门禁配置保存：合并当前值写盘（fire-and-forget） */
function useGuardConfigSave(cfg: {
  enabled: boolean;
  preCommit: boolean;
  prePush: boolean;
  blockOnCritical: boolean;
}): (update: Partial<{ preCommit: boolean; prePush: boolean; blockOnCritical: boolean }>) => void {
  return useCallback(
    (update: Partial<{ preCommit: boolean; prePush: boolean; blockOnCritical: boolean }>) => {
      const config = {
        enabled: cfg.enabled,
        preCommit: update.preCommit ?? cfg.preCommit,
        prePush: update.prePush ?? cfg.prePush,
        blockOnCritical: update.blockOnCritical ?? cfg.blockOnCritical,
      };
      void writeGuardConfig(config);
    },
    [cfg.enabled, cfg.preCommit, cfg.prePush, cfg.blockOnCritical],
  );
}

function GuardConfigHeader({ t }: { t: ReturnType<typeof useT> }) {
  return (
    <div className="flex items-center gap-3 mb-4">
      <h2 className="text-lg font-bold text-zh-ink">
        {t('page.guard.config.title', { defaultValue: '门禁配置' })}
      </h2>
    </div>
  );
}

function GuardConfigToggles({
  t,
  preCommit,
  setPreCommit,
  prePush,
  setPrePush,
  blockCritical,
  setBlockCritical,
  saveConfig,
}: {
  t: ReturnType<typeof useT>;
  preCommit: boolean;
  setPreCommit: Dispatch<SetStateAction<boolean>>;
  prePush: boolean;
  setPrePush: Dispatch<SetStateAction<boolean>>;
  blockCritical: boolean;
  setBlockCritical: Dispatch<SetStateAction<boolean>>;
  saveConfig: (
    update: Partial<{ preCommit: boolean; prePush: boolean; blockOnCritical: boolean }>,
  ) => void;
}) {
  return (
    <div className="space-y-4">
      <ConfigRow
        title={t('page.guard.config.preCommit', { defaultValue: '提交前检查' })}
        desc={t('page.guard.config.preCommitDesc', {
          defaultValue: '每次 git commit 前自动执行门禁检查',
        })}
        enabled={preCommit}
        onToggle={() => {
          const next = !preCommit;
          setPreCommit(next);
          saveConfig({ preCommit: next });
        }}
      />
      <ConfigRow
        title={t('page.guard.config.prePush', { defaultValue: '推送前检查' })}
        desc={t('page.guard.config.prePushDesc', {
          defaultValue: '每次 git push 前自动执行门禁检查',
        })}
        enabled={prePush}
        onToggle={() => {
          const next = !prePush;
          setPrePush(next);
          saveConfig({ prePush: next });
        }}
      />
      <ConfigRow
        title={t('page.guard.config.blockOnCritical', { defaultValue: '严重问题阻止提交' })}
        desc={t('page.guard.config.blockOnCriticalDesc', {
          defaultValue: '当检测到严重级别问题时阻止提交操作',
        })}
        enabled={blockCritical}
        onToggle={() => {
          const next = !blockCritical;
          setBlockCritical(next);
          saveConfig({ blockOnCritical: next });
        }}
      />
    </div>
  );
}

export function GuardConfigCard() {
  const t = useT();
  const {
    preCommit,
    setPreCommit,
    prePush,
    setPrePush,
    blockCritical,
    setBlockCritical,
    enabled,
    loading,
  } = useGuardConfigState();
  const saveConfig = useGuardConfigSave({
    enabled,
    preCommit,
    prePush,
    blockOnCritical: blockCritical,
  });

  if (loading) {
    return (
      <ResultCard variant="section" className="mt-8">
        <GuardConfigHeader t={t} />
        <div className="text-sm text-zh-muted">
          {t('page.guard.config.loading', { defaultValue: '加载中...' })}
        </div>
      </ResultCard>
    );
  }

  return (
    <ResultCard variant="section" className="mt-8">
      <GuardConfigHeader t={t} />
      <GuardConfigToggles
        t={t}
        preCommit={preCommit}
        setPreCommit={setPreCommit}
        prePush={prePush}
        setPrePush={setPrePush}
        blockCritical={blockCritical}
        setBlockCritical={setBlockCritical}
        saveConfig={saveConfig}
      />
    </ResultCard>
  );
}
