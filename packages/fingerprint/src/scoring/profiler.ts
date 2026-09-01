import * as fs from 'fs';
import { safeJoin } from '@zh/shared';
import type {
  ScoringProfileResult,
  ScoringProjectProfile,
  ProfileSignal,
  ProjectLanguage,
  ProjectFramework,
  ProjectType,
  PackageManager,
  Runtime,
  ModuleProfile,
} from './types';
import { scanProject, type ScanResult } from './file-scanner';
import { detectLanguage } from './detectors/language-detector';
import { detectFramework } from './detectors/framework-detector';
import { detectProjectType } from './detectors/type-detector';
import { detectPackageManager } from './detectors/package-manager-detector';
import { detectRuntime } from './detectors/runtime-detector';

const PROFILE_VERSION = '1.0.0';

type InferableField = 'language' | 'framework' | 'type' | 'packageManager' | 'runtime';
const ALL_FIELDS: InferableField[] = ['language', 'framework', 'type', 'packageManager', 'runtime'];

/**
 * 对某字段做加权投票。
 * config-file 信号权重 2（铁证），其他权重 1（佐证）。
 * 返回得票最高的值；无信号返回 undefined。
 */
function voteField<T extends string>(
  signals: ProfileSignal[],
  field: InferableField,
): T | undefined {
  const counts = new Map<T, number>();
  for (const s of signals) {
    const val = s.inferred[field] as T | undefined;
    if (val === undefined) continue;
    counts.set(val, (counts.get(val) ?? 0) + (s.kind === 'config-file' ? 2 : 1));
  }
  let best: T | undefined;
  let bestCount = 0;
  for (const [val, c] of counts) {
    if (c > bestCount) {
      best = val;
      bestCount = c;
    }
  }
  return best;
}

/** 该字段是否有 config-file 级铁证信号 */
function hasConfigFileEvidence(signals: ProfileSignal[], field: InferableField): boolean {
  return signals.some((s) => s.kind === 'config-file' && s.inferred[field] !== undefined);
}

/** 运行单个探测器并对其字段做加权投票 */
function detectField<T extends string>(
  scan: ScanResult,
  detector: (s: ScanResult) => ProfileSignal[],
  field: InferableField,
  fallback: T,
): { value: T; signals: ProfileSignal[] } {
  const signals = detector(scan);
  return { value: voteField<T>(signals, field) ?? fallback, signals };
}

interface DetectedFields {
  allSignals: ProfileSignal[];
  language: ProjectLanguage;
  framework: ProjectFramework;
  type: ProjectType;
  packageManager: PackageManager;
  runtime: Runtime;
}

/** 依次探测语言 / 框架 / 类型 / 包管理器 / 运行时，并汇总全部信号 */
function detectFieldSignals(scan: ScanResult): DetectedFields {
  const allSignals: ProfileSignal[] = [];
  const language = detectField<ProjectLanguage>(scan, detectLanguage, 'language', 'unknown');
  allSignals.push(...language.signals);
  const framework = detectField<ProjectFramework>(scan, detectFramework, 'framework', 'none');
  allSignals.push(...framework.signals);
  const type = detectField<ProjectType>(
    scan,
    (s) => detectProjectType(s, framework.value),
    'type',
    'unknown',
  );
  allSignals.push(...type.signals);
  const packageManager = detectField<PackageManager>(
    scan,
    detectPackageManager,
    'packageManager',
    'unknown',
  );
  allSignals.push(...packageManager.signals);
  const runtime = detectField<Runtime>(
    scan,
    (s) => detectRuntime(s, language.value, framework.value),
    'runtime',
    'unknown',
  );
  allSignals.push(...runtime.signals);
  return {
    allSignals,
    language: language.value,
    framework: framework.value,
    type: type.value,
    packageManager: packageManager.value,
    runtime: runtime.value,
  };
}

/** monorepo 下对每个子包做轻量画像；非 monorepo 返回 undefined */
function detectModules(scan: ScanResult, type: ProjectType): ModuleProfile[] | undefined {
  if (type !== 'monorepo') return undefined;
  const modulePaths = discoverModules(scan);
  return modulePaths
    .map((p) => profileModule(scan, p))
    .filter((m): m is ModuleProfile => m !== null);
}

/** 置信度：有 config-file 铁证的字段占比 */
function computeConfidence(allSignals: ProfileSignal[]): number {
  const evidencedFields = ALL_FIELDS.filter((f) => hasConfigFileEvidence(allSignals, f)).length;
  return Math.round((evidencedFields / ALL_FIELDS.length) * 10) / 10;
}

/** 低置信 / 未识别字段告警 */
function buildWarnings(
  language: ProjectLanguage,
  framework: ProjectFramework,
  type: ProjectType,
  confidence: number,
): string[] {
  const warnings: string[] = [];
  if (language === 'unknown') warnings.push('未能识别项目主语言');
  if (framework === 'none') warnings.push('未探测到具体框架');
  if (type === 'unknown') warnings.push('未能判定项目类型');
  if (confidence < 0.4) warnings.push(`探测置信度偏低 (${confidence})，建议人工核对画像`);
  return warnings;
}

/**
 * 轻量模块画像 — monorepo 下对每个子包做 language/framework/type 探测。
 * 不递归嵌套 monorepo，不收集完整 signals（控制成本）。
 */
function profileModule(scan: ScanResult, moduleRel: string): ModuleProfile | null {
  const moduleRoot = safeJoin(scan.projectRoot, moduleRel);
  if (!fs.existsSync(moduleRoot)) return null;

  const subScan = scanProject(moduleRoot, { maxDepth: 8, maxFiles: 5000 });
  const language = detectModuleLanguage(subScan);
  const framework = detectModuleFramework(subScan);
  const type = detectModuleType(subScan, framework);

  return { path: moduleRel, language, framework, type };
}

function detectModuleLanguage(subScan: ScanResult): ProjectLanguage {
  const langSignals = detectLanguage(subScan);
  return voteField<ProjectLanguage>(langSignals, 'language') ?? 'unknown';
}

function detectModuleFramework(subScan: ScanResult): ProjectFramework {
  const fwSignals = detectFramework(subScan);
  return voteField<ProjectFramework>(fwSignals, 'framework') ?? 'none';
}

function detectModuleType(subScan: ScanResult, framework: ProjectFramework): ProjectType {
  const typeSignals = detectProjectType(subScan, framework);
  return voteField<ProjectType>(typeSignals, 'type') ?? 'unknown';
}

/**
 * 发现 monorepo 子模块路径（packages/* 或 apps/* 或 services/*）
 */
// 模块目录下的噪声子目录：依赖/构建产物/缓存，绝不能当作子包
const MODULE_SCAN_SKIP = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.turbo',
  '.next',
  '.nuxt',
  '.output',
]);

function collectModuleEntries(dir: string, entries: fs.Dirent[], result: string[]): void {
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('.')) continue;
    if (MODULE_SCAN_SKIP.has(e.name)) continue;
    result.push(`${dir}/${e.name}`);
  }
}

function discoverModules(scan: ScanResult): string[] {
  const moduleDirs = ['packages', 'apps', 'services', 'libs', 'modules'];
  const result: string[] = [];
  for (const dir of moduleDirs) {
    const abs = safeJoin(scan.projectRoot, dir);
    if (!fs.existsSync(abs)) continue;
    try {
      collectModuleEntries(
        dir,
        fs.readdirSync(abs, { withFileTypes: true }).filter((e) => e.name !== 'node_modules'),
        result,
      );
    } catch {
      // ignore
    }
  }
  return result;
}

export class ProjectProfiler {
  /**
   * 同步探测项目画像。
   * 错误容忍：任何异常都不抛出，降级为 unknown 画像 + warning。
   */
  profileSync(projectRoot: string): ScoringProfileResult {
    // 根目录不存在 → 降级
    if (!fs.existsSync(projectRoot)) {
      return {
        profile: this.unknownProfile(projectRoot, '项目根目录不存在'),
        warnings: [`项目根目录不存在: ${projectRoot}`],
      };
    }
    let scan: ScanResult;
    try {
      scan = scanProject(projectRoot);
    } catch (err) {
      return {
        profile: this.unknownProfile(projectRoot, '文件扫描失败'),
        warnings: [`文件扫描失败: ${err instanceof Error ? err.message : String(err)}`],
      };
    }
    const { allSignals, language, framework, type, packageManager, runtime } =
      detectFieldSignals(scan);
    const modules = detectModules(scan, type);
    const confidence = computeConfidence(allSignals);
    const warnings = buildWarnings(language, framework, type, confidence);
    const profile: ScoringProjectProfile = {
      version: PROFILE_VERSION,
      projectRoot,
      language,
      secondaryLanguages: this.extractSecondaryLanguages(allSignals, language),
      framework,
      type,
      runtime,
      packageManager,
      isMonorepo: type === 'monorepo',
      detectedFiles: this.collectDetectedFiles(allSignals),
      confidence,
      detectedAt: new Date(),
      modules,
      signals: allSignals,
    };
    return { profile, warnings };
  }

  /** 异步入口（当前同步实现，未来可替换为异步探测器） */
  async profile(projectRoot: string): Promise<ScoringProfileResult> {
    return this.profileSync(projectRoot);
  }

  private unknownProfile(projectRoot: string, reason: string): ScoringProjectProfile {
    return {
      version: PROFILE_VERSION,
      projectRoot,
      language: 'unknown',
      secondaryLanguages: [],
      framework: 'none',
      type: 'unknown',
      runtime: 'unknown',
      packageManager: 'unknown',
      isMonorepo: false,
      detectedFiles: [],
      confidence: 0,
      detectedAt: new Date(),
      signals: [
        {
          file: '(none)',
          kind: 'config-file',
          matched: reason,
          inferred: {},
        },
      ],
    };
  }

  private extractSecondaryLanguages(
    signals: ProfileSignal[],
    primary: ProjectLanguage,
  ): ProjectLanguage[] {
    const langs = new Set<ProjectLanguage>();
    for (const s of signals) {
      const l = s.inferred.language;
      if (l && l !== primary && l !== 'unknown') langs.add(l);
    }
    return [...langs];
  }

  private collectDetectedFiles(signals: ProfileSignal[]): string[] {
    const files = new Set<string>();
    for (const s of signals) {
      if (s.kind === 'config-file' && !s.file.startsWith('(')) {
        files.add(s.file);
      }
    }
    return Array.from(files, (f) => f).toSorted();
  }
}

/** 便捷单例入口（与现有 @zh 包风格一致） */
export const profiler = new ProjectProfiler();

/** 独立函数入口：供 scoring/desktop 直接调用，等价于 profiler.profileSync */
export function profileSync(projectRoot: string): ScoringProfileResult {
  return profiler.profileSync(projectRoot);
}
