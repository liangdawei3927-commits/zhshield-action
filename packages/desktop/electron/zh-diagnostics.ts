export type {
  DiagnosticSeverity,
  DiagnosticEntry,
  LspDiagnostic,
  FileDiagnostics,
  DomainDimensionScore,
  DiagnosticsReport,
} from './zh-diagnostics-types';

export type { DiagnosticSource } from './zh-diagnostics-types';

export {
  normalizePipelineReport,
  normalizeGuardSource,
  normalizeInspectSource,
  normalizeRefactorSource,
} from './zh-diagnostics-normalize';

export {
  buildDiagnosticsReport,
  countSourceEsloc,
} from './zh-diagnostics-esloc';

export {
  domainSnapshotPath,
  writeDiagnosticsFile,
  readDomainSnapshot,
  persistDiagnostics,
  persistDiagnosticsFromEntries,
} from './zh-diagnostics-persist';

export {
  normalizePerformanceData,
  normalizeDepsSource,
  normalizeTechDebtSource,
  normalizeSecuritySource,
} from './zh-diagnostics-engines';

export type { SecurityScanDataLike } from './zh-diagnostics-engines';
