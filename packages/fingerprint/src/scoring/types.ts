/**
 * 评分契约数据模型（由 @zh/profiler 合并入 @zh/fingerprint，供 scoring 使用的轻量同步画像）
 *
 * 设计原则：
 * 1. 零运行时依赖 — 纯 fs 读取，可独立测试，可被任何 @zh 包 type-only 引用
 * 2. 字符串字面量联合类型 — 避免 enum 跨包运行时依赖，利于 type-only import
 * 3. version 字段 — 模型演进时通过版本号做兼容性分支
 * 4. signals 留痕 — 所有探测依据的原始特征都记录，供审计/调试/经验库回写
 * 5. 字段可选化 — 未识别的字段用 unknown/none 兜底，绝不抛错阻断流程
 *
 * 画像驱动评分适配的关键：scoring 包通过 type-only import 引用本文件类型，
 * 在 buildHealthDimensions 入口接受可选 profile 参数实现向后兼容。
 */

export type ProjectLanguage =
  | 'typescript'
  | 'javascript'
  | 'go'
  | 'python'
  | 'rust'
  | 'java'
  | 'kotlin'
  | 'csharp'
  | 'php'
  | 'ruby'
  | 'solidity'
  | 'unknown';

export type ProjectFramework =
  | 'nestjs'
  | 'express'
  | 'fastify'
  | 'koa'
  | 'react'
  | 'vue'
  | 'next'
  | 'nuxt'
  | 'svelte'
  | 'electron'
  | 'react-native'
  | 'flutter'
  | 'weapp'
  | 'taro'
  | 'uni-app'
  | 'spring'
  | 'django'
  | 'flask'
  | 'fastapi'
  | 'gin'
  | 'actix'
  | 'none'
  | 'unknown';

export type ProjectType =
  | 'backend'
  | 'frontend'
  | 'app'
  | 'desktop'
  | 'mini-program'
  | 'library'
  | 'cli'
  | 'monorepo'
  | 'unknown';

export type PackageManager =
  | 'npm'
  | 'pnpm'
  | 'yarn'
  | 'bun'
  | 'go-mod'
  | 'pip'
  | 'poetry'
  | 'cargo'
  | 'maven'
  | 'gradle'
  | 'composer'
  | 'unknown';

export type Runtime =
  | 'node'
  | 'bun'
  | 'deno'
  | 'browser'
  | 'electron'
  | 'go'
  | 'python'
  | 'rust'
  | 'jvm'
  | 'dotnet'
  | 'unknown';

/**
 * 探测信号 — 一条信号 = 一个文件特征 → 一组推断
 * 留痕目的：审计画像是怎么得出来的、经验库可回写校准
 */
export interface ProfileSignal {
  /** 信号来源文件相对路径 */
  file: string;
  /** 信号种类 */
  kind: 'config-file' | 'dependency' | 'source-pattern' | 'directory-structure';
  /** 命中的具体特征（如依赖名 "@nestjs/core" 或文件名 "go.mod"） */
  matched: string;
  /** 该信号推断出的字段值 */
  inferred: {
    language?: ProjectLanguage;
    framework?: ProjectFramework;
    type?: ProjectType;
    packageManager?: PackageManager;
    runtime?: Runtime;
  };
}

/**
 * 模块级画像 — monorepo 下按子包/子目录展开
 * 对应工作记忆里"细化到模块级（后端/官网/后台/APP/小程序）独立调度"
 */
export interface ModuleProfile {
  /** 模块相对路径（如 "packages/server"） */
  path: string;
  language: ProjectLanguage;
  framework: ProjectFramework;
  type: ProjectType;
}

/**
 * 完整项目画像 — Profiler 的输出契约
 *
 * 演进约定：
 * - 新增字段时 version minor +1
 * - 字段语义变更时 version major +1，并在 ProjectProfiler 内做版本兼容
 * - 消费方（scoring 等）应容忍未知字段，按 version 做特性开关
 */
export interface ScoringProjectProfile {
  /** 画像模型版本，当前 '1.0.0' */
  version: string;
  /** 项目根绝对路径 */
  projectRoot: string;
  /** 主语言（按文件数/特征权重判定） */
  language: ProjectLanguage;
  /** 次要语言（monorepo 或混合项目） */
  secondaryLanguages: ProjectLanguage[];
  /** 主框架 */
  framework: ProjectFramework;
  /** 项目类型 */
  type: ProjectType;
  /** 运行时 */
  runtime: Runtime;
  /** 包管理器 */
  packageManager: PackageManager;
  /** 是否 monorepo */
  isMonorepo: boolean;
  /** 探测到的配置文件清单（相对路径） */
  detectedFiles: string[];
  /** 探测置信度 0-1，低于阈值时上层应触发人工核对兜底 */
  confidence: number;
  /** 探测时间戳 */
  detectedAt: Date;
  /** 模块级画像（仅 monorepo 时填充） */
  modules?: ModuleProfile[];
  /** 原始探测信号（审计/调试/经验库回写用） */
  signals: ProfileSignal[];
}

/**
 * 探测结果 — 包含画像与可能的告警
 */
export interface ScoringProfileResult {
  profile: ScoringProjectProfile;
  /** 低置信度或冲突信号告警（不阻断流程，供上层 UI 提示人工核对） */
  warnings: string[];
}
