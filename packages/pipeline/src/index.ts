// @zh/pipeline — 核心流水线编排器
export const VERSION = '0.1.0';
export { PipelineRunner } from './pipeline-runner';
export { createReport } from './types';
export type { PipelineReport } from './types';
export { detectProjectProfile } from './project-profile';
export type { ProjectProfile, ProjectLanguage, PackageManager } from './project-profile';
