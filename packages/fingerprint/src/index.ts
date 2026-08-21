// @zh/fingerprint 入口文件（架构文档 §11.2）
// 导出 Profiler / ProfileStore / DriftDetector / QuestionSet + 工厂函数

// ─── 准确率评估（§10.2） ───
export { evaluateAccuracy, loadGoldenDir } from './accuracy';
export type { GoldenAssertion, DetectorEvaluation, AccuracyReport } from './accuracy';

// ─── 类型导出 ───
export type {
  // 数据模型（types.ts）
  LanguageId,
  ProductFormId,
  ArchitectureForm,
  MatchResult,
  Signal,
  SignalKind,
  TargetProfile,
  ProjectProfile,
  UserOverrides,
  DependencySummary,
} from './types';

export type {
  // Detector 接口（detector.ts）
  Detector,
  DetectorId,
} from './detector';

export type {
  // DriftDetector 相关（drift-detector.ts）
  DriftResult,
  DriftRecommendation,
} from './drift-detector';

export type {
  // QuestionSet 相关（question-set.ts）
  Question,
  QuestionOption,
  QuestionType,
  QuestionPriority,
  RuleServes,
} from './question-set';

// ─── 类导出 ───
export { Profiler, createProfiler } from './profiler';
export { ProfileStore, createProfileStore } from './profile-store';
export type { ProfileEventBus } from './profile-store';
export { DriftDetector, createDriftDetector } from './drift-detector';
export { QuestionSet, createQuestionSet, createDefaultServes } from './question-set';

// ─── Detector 实现导出 ───
export { ManifestDetector } from './detectors/manifest-detector';
export { ConfigDetector } from './detectors/config-detector';
export { ExtStatDetector } from './detectors/ext-stat-detector';
export { ContentDetector } from './detectors/content-detector';
export { FormDetector } from './detectors/form-detector';
export { LockfileDetector } from './detectors/lockfile-detector';

// ─── 投影导出（§11.1 ProjectProfile → ProjectFeature） ───
export { toFeature } from './projection';
export type { ProjectFeatureLike } from './projection';

// ─── 常量导出 ───
export { DETECTOR_IDS, SKIP_DIRS } from './detector';
export {
  EXTENSION_LANGUAGES,
  STAT_LANGUAGES,
  MANIFEST_RULES,
  LOCKFILE_MANAGERS,
  CONFIG_RULES,
  ENVIRONMENT_NAMES,
  FORM_FILE_RULES,
  FORM_DIR_RULES,
  slugify,
} from './language-map';
export {
  FRAMEWORK_KEYWORDS,
  SERVER_FRAMEWORK_DEP_KEYWORDS,
} from './framework-map';

// ─── 便捷 API ───

import { createProfiler } from './profiler';
import { createProfileStore } from './profile-store';
import { DriftDetector, createDriftDetector } from './drift-detector';
import { QuestionSet, createQuestionSet, createDefaultServes } from './question-set';
import { ManifestDetector } from './detectors/manifest-detector';
import { ConfigDetector } from './detectors/config-detector';
import { ExtStatDetector } from './detectors/ext-stat-detector';
import { ContentDetector } from './detectors/content-detector';
import { FormDetector } from './detectors/form-detector';
import { LockfileDetector } from './detectors/lockfile-detector';
import type { ProjectProfile, UserOverrides } from './types';
import type { RuleServes } from './question-set';

/**
 * 创建默认 Detector 列表
 */
export function createDefaultDetectors() {
  return [
    new ManifestDetector(),
    new ConfigDetector(),
    new ExtStatDetector(),
    new ContentDetector(),
    new FormDetector(),
    new LockfileDetector(),
  ];
}

/**
 * 完整的项目画像探测流程（架构文档 §6.4）
 * @param projectPath 项目根路径
 * @param options 可选配置
 * @returns 项目画像 + 问题集
 */
export async function profileProject(
  projectPath: string,
  options?: {
    detectors?: ReturnType<typeof createDefaultDetectors>;
    serves?: RuleServes;
    overrides?: UserOverrides;
  },
): Promise<{
  profile: ProjectProfile;
  questions: ReturnType<QuestionSet['generate']>;
  drift: ReturnType<DriftDetector['detect']>;
}> {
  // 1. 创建组件
  const detectors = options?.detectors ?? createDefaultDetectors();
  const serves = options?.serves ?? createDefaultServes();
  const profiler = createProfiler(detectors);
  const profileStore = createProfileStore();
  const driftDetector = createDriftDetector(projectPath);
  const questionSet = createQuestionSet(serves);

  // 2. 检查漂移
  const existingProfile = profileStore.load(projectPath);
  const drift = driftDetector.detect(existingProfile);

  // 3. 执行画像探测
  const profile = await profiler.profile(projectPath, options?.overrides);

  // 4. 保存画像
  profileStore.save(projectPath, profile);

  // 5. 生成问题集
  const questions = questionSet.generate(profile);

  return { profile, questions, drift };
}

/**
 * 确认画像（用户确认后调用）
 * @param projectPath 项目根路径
 * @param overrides 用户修正
 * @returns 更新后的画像
 */
export function confirmProfile(
  projectPath: string,
  overrides: UserOverrides,
): ProjectProfile {
  const profileStore = createProfileStore();
  return profileStore.mergeOverridesAndSave(projectPath, overrides);
}
