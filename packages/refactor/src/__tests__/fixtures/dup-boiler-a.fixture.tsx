// fixture: 与 dup-boiler-b 仅共享 SVG 图标属性 / ToolAdapter 扫描骨架 / hook 接线收尾样板，
// 无真实重复逻辑。回归目标：isUniversalBoilerplate 必须在 collectCodeBlocks 阶段过滤这些
// 「同类实现必然雷同、语义头各异」的不可提取样板，而不是让它们进入重复区计数。
import { useCallback } from 'react';
import type { ReactNode } from 'react';

interface ToolScanOptions { projectId: string; root: string; }
interface ToolResult { success: boolean; data: string[]; timestamp: string; }
type ExecError = Error & { code: number };

export function ShieldIconA({ label }: { label: string }): ReactNode {
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
      <title>{label}</title>
      <path d="M12 2l8 4v6c0 5-3 8-8 10-5-2-8-5-8-10V6l8-4z" />
    </svg>
  );
}

export class NpmScanA {
  private async exec(cmd: string): Promise<string> {
    const out = await window.tools.runInShell(cmd);
    return out.stdout ?? '';
  }

  async scan(options: ToolScanOptions): Promise<ToolResult> {
    const start = Date.now();
    try {
      const { stdout } = await this.exec(options.root + '/npm-out.txt');
      if (stdout.length > 0) {
        return { success: true, data: stdout.split('\n'), timestamp: new Date().toISOString() };
      }
      return this.buildErrorResult(start, new Error('空输出'));
    } catch (error) {
      return this.buildErrorResult(start, error as ExecError);
    }
  }

  buildErrorResult(start: number, err: ExecError): ToolResult {
    console.error('扫描失败', err);
    return { success: false, data: [err.message], timestamp: new Date().toISOString() };
  }

  private normalizeNpm(lines: string[]): string[] {
    return lines.filter((l) => l.includes('npm'));
  }
}

export function useCopyRow(active: boolean) {
  const copyToAI = useCallback(() => window.api.copyToAI(), [active]);
  const copyAllToAI = useCallback(() => window.api.copyAllToAI(), [active]);
  return {
    copyToAI,
    copyAllToAI,
  };
}