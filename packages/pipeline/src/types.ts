import type { GuardReport } from '@zh/guard';
import type { InspectionReport } from '@zh/inspect';
import type { RefactorReport } from '@zh/refactor';
import type { RuleEngineReport } from '@zh/kernel';
import type { SecurityScanReport } from '@zh/security';
import type { HealthScore } from '@zh/scoring';
import type { ProjectProfile } from './project-profile';

/**
 * Unified report produced by both the checks.json pipeline (`PipelineRunner.runFullPipeline`)
 * and the SOP-driven pipeline (`SopPipelineRunner.runSopDrivenPipeline`).
 *
 * Fields are populated progressively as stages complete; null indicates the stage was not reached
 * (e.g., pipeline failed fast before Security ran → `security` is null).
 */
export interface PipelineReport {
  /** ISO timestamp of when the report was created */
  timestamp: Date;

  /** Guard stage output — {@link GuardReport} in checks.json mode, {@link RuleEngineReport} in SOP mode, or null if Guard was not run */
  guard: GuardReport | RuleEngineReport | null;

  /** Inspect stage output — {@link InspectionReport} in checks.json mode, {@link RuleEngineReport} in SOP mode, or null if Inspect was not reached */
  inspect: InspectionReport | RuleEngineReport | null;

  /** Refactor stage output (only populated when run via desktop client), null in pipeline paths */
  refactor: RefactorReport | null;

  /** Detected project profile (language, framework, package manager), null if detection failed */
  profile: ProjectProfile | null;

  /** Security scan output (only in checks.json full pipeline), null in SOP path or if Security stage failed */
  security: SecurityScanReport | null;

  /** Health score computed from Guard + Inspect results (only in checks.json full pipeline), null in SOP path */
  score: HealthScore | null;

  /** Whether the pipeline completed all intended stages without a fail-fast gate triggering */
  passed: boolean;

  /**
   * Indicates how far the pipeline progressed:
   * - `'guard'` — failed during Guard (fail-fast gate)
   * - `'inspect'` — failed during Inspect (fail-fast gate)
   * - `'refactor'` — failed during Refactor (desktop path only)
   * - `'complete'` — all intended stages finished
   * - `'failed'` — unexpected failure
   */
  stage: 'guard' | 'inspect' | 'refactor' | 'complete' | 'failed';

  /** Error message when the pipeline failed (absent on success) */
  error?: string;
}

export function createReport(
  partial: Pick<PipelineReport, 'passed' | 'stage'> &
    Partial<Omit<PipelineReport, 'passed' | 'stage'>>,
): PipelineReport {
  return {
    timestamp: new Date(),
    guard: null,
    inspect: null,
    refactor: null,
    profile: null,
    security: null,
    score: null,
    ...partial,
  };
}
