// fixture: 与 dup-boiler-a 仅共享 SVG 图标属性 / ToolAdapter 骨架 / hook 接线收尾样板，
// 无真实重复逻辑。语义头（工具名、scan 实现、copy 回调体）各异，只有结构尾巴雷同。
// 回归目标：isUniversalBoilerplate 过滤后应为 0 条 duplicated-code。
import { useCallback } from 'react';
import type { ReactNode } from 'react';

interface ToolScanOptionsPip { root: string; }
interface ToolResult { success: boolean; data: string[]; timestamp: string; }
type ExecError = Error & { code: number };

export function ShieldIconB({ label }: { label: string }): ReactNode {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 3h14v4l-4 6v8H9v-8L5 7z" />
    </svg>
  );
}

export class PipScanAdapter {
  async isAvailable(): Promise<boolean> {
    return this.commands.isAvailable('pip');
  }

  async scan(options: ToolScanOptionsPip): Promise<ToolResult> {
    const start = Date.now();
    try {
      const scanned = await window.tools.runPip(options.root);
      return { success: true, data: scanned, timestamp: new Date().toISOString() };
    } catch (error) {
      return this.buildErrorResult(start, error as ExecError);
    }
  }

  buildErrorResult(start: number, err: ExecError): ToolResult {
    console.error('扫描失败', err);
    return { success: false, data: [], timestamp: new Date().toISOString() };
  }

  private normalizePip(lines: string[]): string[] {
    return lines.filter((l) => l.startsWith('pip '));
  }
}

function useScanCopyButtons(active: boolean, flag: boolean) {
  const copyRunB = useCallback(() => window.api.runScanB(), [active, flag]);
  const copyToAI = useCallback(() => window.api.copyToAI(), [active, flag]);
  const copyAllToAI = useCallback(() => window.api.copyAllToAI(), [active, flag]);
  return {
    copyToAI,
    copyAllToAI,
  };
}