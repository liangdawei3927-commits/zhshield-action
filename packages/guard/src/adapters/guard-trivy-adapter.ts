import { TrivyAdapter, type TrivyFinding } from './trivy-adapter';
import type { Adapter, CheckConfig, CheckResult } from '../types';

export interface GuardTrivyResult {
  adapterId: string;
  status: 'passed' | 'failed' | 'error';
  severity: 'low' | 'medium' | 'high' | 'critical';
  message: string;
  findings: TrivyFinding[];
  summary: {
    total: number;
    critical: number;
    high: number;
    medium: number;
    low: number;
  };
}

/**
 * GuardTrivyAdapter - bridges TrivyAdapter to the guard adapter interface
 */
export class GuardTrivyAdapter implements Adapter {
  id = 'trivy';
  name = 'Trivy Security Scanner';

  private adapter: TrivyAdapter;

  constructor(trivyPath?: string) {
    this.adapter = new TrivyAdapter(trivyPath);
  }

  /**
   * 检查适配器是否可用
   */
  async isAvailable(): Promise<boolean> {
    return this.adapter.isAvailable();
  }

  /**
   * 运行门禁检查
   */
  async check(projectPath: string): Promise<GuardTrivyResult> {
    try {
      if (!(await this.isAvailable())) {
        return this.unavailableResult();
      }
      const result = await this.adapter.scan(projectPath);
      return this.buildScanResult(result);
    } catch (err) {
      return this.scanErrorResult(err);
    }
  }

  /** 构造 Trivy 未安装时的错误结果 */
  private unavailableResult(): GuardTrivyResult {
    return {
      adapterId: this.id,
      status: 'error',
      severity: 'low',
      message: 'Trivy is not installed or not in PATH',
      findings: [],
      summary: { total: 0, critical: 0, high: 0, medium: 0, low: 0 },
    };
  }

  /** 根据扫描结果构造门禁判定 */
  private buildScanResult(result: Awaited<ReturnType<TrivyAdapter['scan']>>): GuardTrivyResult {
    const hasCritical = result.summary.critical > 0;
    const hasHigh = result.summary.high > 0;

    return {
      adapterId: this.id,
      status: hasCritical ? 'failed' : hasHigh ? 'failed' : 'passed',
      severity: hasCritical
        ? 'critical'
        : hasHigh
          ? 'high'
          : result.summary.medium > 0
            ? 'medium'
            : 'low',
      message: hasCritical
        ? `Found ${result.summary.critical} critical vulnerabilities`
        : hasHigh
          ? `Found ${result.summary.high} high severity vulnerabilities`
          : `No critical or high severity issues found`,
      findings: [...result.vulnerabilities, ...result.misconfigurations],
      summary: result.summary,
    };
  }

  /** 构造扫描异常时的错误结果 */
  private scanErrorResult(err: unknown): GuardTrivyResult {
    return {
      adapterId: this.id,
      status: 'error',
      severity: 'low',
      message: `Trivy scan failed: ${err instanceof Error ? err.message : String(err)}`,
      findings: [],
      summary: { total: 0, critical: 0, high: 0, medium: 0, low: 0 },
    };
  }

  // --- Adapter interface methods ---

  async run(context: { projectPath?: string }, _check: CheckConfig): Promise<GuardTrivyResult> {
    const projectPath = context.projectPath || process.cwd();
    return this.check(projectPath);
  }

  normalize(rawResult: GuardTrivyResult, _context: unknown, check: CheckConfig): CheckResult {
    return {
      checkId: check.checkId,
      adapter: check.adapter,
      status: rawResult.status,
      severity:
        rawResult.status === 'failed' || rawResult.status === 'error' ? check.severity : 'info',
      blocking: check.blocking && (rawResult.status === 'failed' || rawResult.status === 'error'),
      message: rawResult.message,
      details: rawResult,
    };
  }
}
