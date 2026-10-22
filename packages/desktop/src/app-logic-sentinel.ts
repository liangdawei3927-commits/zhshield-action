import {
  useCallback,
  useEffect,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { t } from '@zh/i18n';
import type { ToastVariant } from './components/ui/toast-logic';
import { getSentinelState, setSentinelEnabled } from './services/engineApi';

/** 哨兵总开关：读写 sentinel-state.json 的 enabled 字段 */
function useLoadSentinelConfig(
  setSentinelEnabledState: Dispatch<SetStateAction<boolean | null>>,
  setSentinelLoading: Dispatch<SetStateAction<boolean>>,
): void {
  useEffect(() => {
    let cancelled = false;
    getSentinelState()
      .then((state) => {
        if (!cancelled) {
          setSentinelEnabledState(state.enabled);
          setSentinelLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSentinelEnabledState(true);
          setSentinelLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);
}

async function saveSentinelConfig(
  enabled: boolean,
  setSentinelEnabledState: Dispatch<SetStateAction<boolean | null>>,
  toast: (msg: string, variant?: ToastVariant) => void,
): Promise<void> {
  try {
    const result = await setSentinelEnabled(enabled);
    if (!result.ok) {
      setSentinelEnabledState(!enabled);
      toast(t('toast.sentinelConfigSaveFailed'), 'error');
    }
  } catch {
    setSentinelEnabledState(!enabled);
    toast(t('toast.sentinelConfigSaveFailed'), 'error');
  }
}

export function useSentinelSwitch(toast: (msg: string, variant?: ToastVariant) => void): {
  sentinelEnabled: boolean | null;
  setSentinelEnabledState: (enabled: boolean) => void;
  sentinelLoading: boolean;
} {
  const [sentinelEnabled, setSentinelEnabledState] = useState<boolean | null>(null);
  const [sentinelLoading, setSentinelLoading] = useState(true);
  useLoadSentinelConfig(setSentinelEnabledState, setSentinelLoading);
  const setEnabled = useCallback(
    async (enabled: boolean) => {
      setSentinelEnabledState(enabled);
      await saveSentinelConfig(enabled, setSentinelEnabledState, toast);
    },
    [toast],
  );
  return { sentinelEnabled, setSentinelEnabledState: setEnabled, sentinelLoading };
}
