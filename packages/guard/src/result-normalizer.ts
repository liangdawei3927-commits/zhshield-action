import type { CheckConfig, CheckResult, CheckStatus } from './types';

export class ResultNormalizer {
  fromException(check: CheckConfig, error: unknown): CheckResult {
    return {
      checkId: check.checkId,
      adapter: check.adapter,
      status: 'error',
      severity: check.severity,
      blocking: check.blocking,
      message: error instanceof Error ? error.message : String(error),
      duration: 0,
    };
  }

  normalize(
    status: CheckStatus,
    message: string,
    check: CheckConfig,
    details?: unknown,
  ): CheckResult {
    return {
      checkId: check.checkId,
      adapter: check.adapter,
      status,
      severity: check.severity,
      blocking: check.blocking,
      message,
      details,
    };
  }
}
