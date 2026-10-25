/**
 * `app-logic` 的开关族 hook：AI 工具配置 + 门禁总开关 + 智能引擎总开关。
 *
 * 从 `app-logic.ts` 按职责拆出（原文件超 400 行代码阈值）；
 * 公共类型 / 常量在 `app-logic-types.ts`。
 */

import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { t } from '@zh/i18n';
import type { AiToolConfigData } from './types/electron';
import { readGuardConfig, writeGuardConfig } from './services/engineApi';
import type { ToastVariant } from './components/ui/toast-logic';
import { DEFAULT_AI_TOOL, type ProjectInfo } from './app-logic-types';

/** AI 工具开关：配置状态 + 保存回调 */
export function useAiToolConfig(
  projects: ProjectInfo[],
  toast: (msg: string, variant?: ToastVariant) => void,
): {
  aiTool: AiToolConfigData | null;
  setAiTool: Dispatch<SetStateAction<AiToolConfigData | null>>;
  aiApplying: boolean;
  toggleAiTool: (enabled: boolean) => Promise<void>;
} {
  const [aiTool, setAiTool] = useState<AiToolConfigData | null>(null);
  const [aiApplying, setAiApplying] = useState(false);

  const toggleAiTool = useCallback(
    async (enabled: boolean) => {
      const current = aiTool ?? DEFAULT_AI_TOOL;
      const next = { ...current, enabled };
      setAiTool(next);
      setAiApplying(true);
      try {
        const result = await window.electronAPI?.ai?.saveConfig(
          next,
          projects.map((p) => p.path),
        );
        if (result?.saved) {
          notifyAiToolResult(enabled, result, toast);
        } else {
          toast(t('toast.aiToolSaveFailed'), 'error');
        }
      } catch {
        toast(t('toast.aiToolSaveFailed'), 'error');
        setAiTool({ ...(aiTool ?? DEFAULT_AI_TOOL), enabled: !enabled });
      } finally {
        setAiApplying(false);
      }
    },
    [aiTool, projects, toast],
  );

  return { aiTool, setAiTool, aiApplying, toggleAiTool };
}

export function notifyAiToolResult(
  enabled: boolean,
  result: { projects: Array<{ ok: boolean }>; saved: boolean },
  toast: (msg: string, variant?: ToastVariant) => void,
): void {
  if (!enabled) {
    toast(t('toast.aiToolDisabled'), 'info');
    return;
  }
  if (result.projects.length === 0) {
    toast(t('toast.aiToolEnabledNoProjects'), 'info');
    return;
  }
  const okCount = result.projects.filter((p) => p.ok).length;
  toast(
    t('toast.aiToolEnabledWritten', { written: okCount, total: result.projects.length }),
    okCount === result.projects.length ? 'success' : 'warning',
  );
}

/** 门禁总开关：读写 guard-config.json 的 enabled 字段 */
function useLoadGateConfig(
  setGateEnabledState: Dispatch<SetStateAction<boolean | null>>,
  setGateLoading: Dispatch<SetStateAction<boolean>>,
): void {
  useEffect(() => {
    let cancelled = false;
    readGuardConfig()
      .then((config) => {
        if (!cancelled) {
          setGateEnabledState(config.enabled);
          setGateLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setGateEnabledState(true);
          setGateLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);
}

async function saveGateConfig(
  enabled: boolean,
  setGateEnabledState: Dispatch<SetStateAction<boolean | null>>,
  toast: (msg: string, variant?: ToastVariant) => void,
): Promise<void> {
  try {
    const current = await readGuardConfig();
    await writeGuardConfig({ ...current, enabled });
  } catch {
    setGateEnabledState(!enabled);
    toast(t('toast.guardConfigSaveFailed'), 'error');
  }
}

export function useGateSwitch(toast: (msg: string, variant?: ToastVariant) => void): {
  gateEnabled: boolean | null;
  setGateEnabled: (enabled: boolean) => void;
  gateLoading: boolean;
} {
  const [gateEnabled, setGateEnabledState] = useState<boolean | null>(null);
  const [gateLoading, setGateLoading] = useState(true);
  useLoadGateConfig(setGateEnabledState, setGateLoading);
  const setGateEnabled = useCallback(
    async (enabled: boolean) => {
      setGateEnabledState(enabled);
      await saveGateConfig(enabled, setGateEnabledState, toast);
    },
    [toast],
  );
  return { gateEnabled, setGateEnabled, gateLoading };
}

/**
 * 智能引擎总开关：一个开关联动「门禁系统 + 哨兵监控」两侧。
 * 「完全合并」模式——门禁/哨兵不再单独可开关，均由本开关驱动。
 */
export function useIntelligentEngineSwitch(
  gate: { gateEnabled: boolean | null; setGateEnabled: (v: boolean) => void; gateLoading: boolean },
  sentinel: {
    sentinelEnabled: boolean | null;
    setSentinelEnabledState: (v: boolean) => void;
    sentinelLoading: boolean;
  },
): {
  intelligentEnabled: boolean;
  setIntelligentEnabled: (enabled: boolean) => void;
  intelligentLoading: boolean;
} {
  const [toggling, setToggling] = useState(false);
  // 未加载完按「开」处理，避免启动时闪烁（与原来各子开关默认常开一致）
  const intelligentEnabled = (gate.gateEnabled ?? true) && (sentinel.sentinelEnabled ?? true);
  const setIntelligentEnabled = useCallback(
    (enabled: boolean) => {
      setToggling(true);
      gate.setGateEnabled(enabled);
      sentinel.setSentinelEnabledState(enabled);
      // 乐观更新后，底层异步落盘；短暂标记加载态保持观感一致
      const timer = setTimeout(setToggling, 120, false);
      return () => clearTimeout(timer);
    },
    [gate, sentinel],
  );
  return {
    intelligentEnabled,
    setIntelligentEnabled,
    intelligentLoading: toggling || gate.gateLoading || sentinel.sentinelLoading,
  };
}
