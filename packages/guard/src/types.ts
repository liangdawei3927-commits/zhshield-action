export type CheckMode = 'inspection' | 'guard';
export type CheckStatus = 'passed' | 'failed' | 'error' | 'warning';
export type RiskLevel = 'low' | 'medium' | 'high';

export interface CheckOptions {
  mode: CheckMode;
  profile?: string;
  checks?: string[];
  format?: 'json' | 'markdown' | 'both';
  target?: string;
  riskLevel?: RiskLevel;
  environment?: string;
  triggerSource?: string;
  dryRun?: boolean;
}

export interface CheckResult {
  checkId: string;
  adapter: string;
  status: CheckStatus;
  severity: 'error' | 'warning' | 'info';
  blocking: boolean;
  message: string;
  details?: unknown;
  duration?: number;
}

export interface GuardReport {
  contractVersion: string;
  mode: CheckMode;
  profile: string;
  target: string;
  ok: boolean | null;
  dryRun: boolean;
  summary: {
    total: number;
    passed: number;
    failed: number;
    warnings: number;
    blocking: number;
    errors: number;
  };
  results: CheckResult[];
  generatedAt: string;
}

export interface CheckConfig {
  checkId: string;
  adapter: string;
  enabled: boolean;
  mode: CheckMode[];
  category: string;
  severity: 'error' | 'warning' | 'info';
  blocking: boolean;
  description: string;
  appliesTo?: { targets?: string[] };
}

export interface Adapter {
  run(context: unknown, check: CheckConfig): unknown;
  normalize(rawResult: unknown, context: unknown, check: CheckConfig): CheckResult;
}
