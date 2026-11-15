/**
 * 垃圾页「扫描对象」与「发起扫描」两个动作的装配（从 garbage-logic.ts 拆出）。
 *
 * 拆分理由有二：
 *   1. 页面逻辑文件已到坏味道门禁的单文件行数阈值，按功能拆分比继续堆叠更安全；
 *   2. 「扫谁」与「怎么扫」是独立语义：默认扫页面所属项目，用户确认后才改扫唯一子项目
 *      （2026-11-09 事故的教训：扫描根被静默换掉，页面却显示旧报告的 100 分）。
 *
 * 本模块不直接依赖引擎：真正的扫描函数由调用方注入，保持单测可用、依赖方向单一。
 */
import {
  useCallback,
  useEffect,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import type { GarbageScanReportData } from '../types/electron';

/** 改扫目标：垃圾页可在「当前项目」与「检测到的唯一子项目」之间切换 */
export interface GarbageScanTarget {
  path: string;
  name: string;
}

/** 一次真实扫描（含错误语义由调用方实现；本模块不关心怎么扫，只关心扫谁） */
type ScanFn = (targetPath: string) => Promise<void>;

interface ScanTargetParams {
  projectPath: string;
  report: GarbageScanReportData | null;
  scan: ScanFn;
}

/**
 * 扫描对象状态：默认是页面所属项目，用户确认「改扫子项目」后才换成子项目。
 *
 * @param report 最新报告（用来取其中的 nestedProject 建议）
 * @returns 当前对象、建议、切换器与「按当前对象重扫」入口
 */
export function useGarbageScanTarget({ projectPath, report, scan }: ScanTargetParams): {
  scanTarget: GarbageScanTarget | null;
  setScanTarget: Dispatch<SetStateAction<GarbageScanTarget | null>>;
  nestedSuggestion: GarbageScanTarget | null;
  refreshReport: () => Promise<void>;
} {
  const [scanTarget, setScanTarget] = useState<GarbageScanTarget | null>(null);
  const [nestedSuggestion, setNestedSuggestion] = useState<GarbageScanTarget | null>(null);
  const scanPath = scanTarget?.path ?? projectPath;
  const refreshReport = useCallback(() => scan(scanPath), [scan, scanPath]);
  // 建议只在扫默认项目时更新：子项目的报告里不再带建议，保留原值以便切回时仍有入口
  useEffect(() => {
    if (!scanTarget) setNestedSuggestion(report?.nestedProject ?? null);
  }, [report, scanTarget]);
  return { scanTarget, setScanTarget, nestedSuggestion, refreshReport };
}

interface ScanActionsParams {
  projectPath: string;
  refreshReport: () => Promise<void>;
  clearResults: (keepBanner: boolean) => void;
  setScanTarget: Dispatch<SetStateAction<GarbageScanTarget | null>>;
  scan: ScanFn;
}

/**
 * 两个「发起扫描」的入口：普通重扫（可保留清理结果横幅）与换对象后重扫。
 * 都落到同一条 refresh 路径，避免「改扫」与「重新扫描」在参数上分叉。
 */
export function useGarbageScanActions({
  projectPath,
  refreshReport,
  clearResults,
  setScanTarget,
  scan,
}: ScanActionsParams): {
  handleScan: (keepBanner?: boolean) => Promise<void>;
  switchScanTarget: (target: GarbageScanTarget | null) => Promise<void>;
} {
  const handleScan = useCallback(
    async (keepBanner = false) => {
      clearResults(!keepBanner);
      await refreshReport();
    },
    [refreshReport, clearResults],
  );
  // 先记目标再扫：页面标注「本次扫描对象」与真正跑的目标必须同时生效
  const switchScanTarget = useCallback(
    async (target: GarbageScanTarget | null) => {
      clearResults(true);
      setScanTarget(target);
      await scan(target?.path ?? projectPath);
    },
    [projectPath, clearResults, setScanTarget, scan],
  );
  return { handleScan, switchScanTarget };
}
