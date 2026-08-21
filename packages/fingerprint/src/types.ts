// 项目画像数据模型（架构文档 §5.1 原样 + 信号规则扩展：Signal 携带 kind/weight）。

/** 信号种类：Detector 声明产出的信号类型（§6.1 signalKinds）。 */
export type SignalKind = 'manifest' | 'config' | 'ext-stat' | 'content' | 'form' | 'lockfile';

/** 语言 ID（开放类型）：'typescript' | 'python' | 'go' ... */
export type LanguageId = string;

/** 交付物形态 ID（开放类型）：'website' | 'admin' | 'mobile' | 'miniprogram' | 'pc' | 'ios' | 'android' | 'h5' | 'backend' ... */
export type ProductFormId = string;

/** 架构形态：单体 / 模块化单体 / 微服务 / 未知 */
export type ArchitectureForm = 'monolith' | 'modular-monolith' | 'microservices' | 'unknown';

/** 单条检测信号：判定的可追溯依据（检测层产出，Profiler 消费）。 */
export interface Signal {
  /** 规则 ID：'manifest:package-json' | 'config:tsconfig' | 'ext-stat:ts' | 'content:shebang' | 'form:electron' | 'lockfile:pnpm' ... */
  readonly ruleId: string;
  /** 信号种类（= 产出该信号的 Detector 的 signalKinds 之一） */
  readonly kind: SignalKind;
  /** 命中文件相对项目根路径 */
  readonly file: string;
  /** 信号权重（= 产出该信号的 Detector 权重：manifest=1.0, config=0.8, ext-stat=0.6, content=0.4） */
  readonly weight: number;
  /** 命中内容（依赖名、版本、统计等） */
  readonly payload: unknown;
}

/** 某个判定维度的结果：值 + 置信度 + 支撑信号。 */
export interface MatchResult<T = string> {
  readonly value: T;
  /** 0 ~ 1 */
  readonly confidence: number;
  /** 该判定的支撑依据 */
  readonly signals: readonly Signal[];
}

/** 人工修正记录（与自动检测分离存储，永不丢失）。 */
export interface UserOverrides {
  readonly architecture?: ArchitectureForm;
  readonly targets?: Readonly<Record<string, { readonly language?: LanguageId; readonly productForm?: ProductFormId }>>;
  readonly updatedAt?: string;
}

/** lockfile 解析结果（M0 只存清单供展示 / SCA 后续用）。 */
export interface DependencySummary {
  readonly packageManager?: string;
  readonly direct: readonly { readonly name: string; readonly version: string }[];
  readonly lockfilePath?: string;
}

/** 单目标画像（M0 常驻 ≥1，为 M1 模块级画像预留）。 */
export interface TargetProfile {
  /** 'web' | 'admin' | 'miniapp' ... */
  readonly id: string;
  /** 相对项目根目录 */
  readonly path: string;
  readonly language: MatchResult<LanguageId>;
  readonly frameworks: readonly MatchResult<string>[];
  /** 仅当规则库声明了该形态才填充 / 询问 */
  readonly productForm?: MatchResult<ProductFormId>;
  readonly packageManager?: MatchResult<string>;
  /** `${language}:${framework}:${form}` 能力查询键 */
  readonly routeKey: string;
}

/** 项目整体画像（schemaVersion=1）。 */
export interface ProjectProfile {
  /** 数据结构版本，防迁移事故 */
  readonly schemaVersion: number;
  readonly architecture: MatchResult<ArchitectureForm>;
  /** M0 常驻 ≥1，为 M1 模块级画像预留 */
  readonly targets: readonly TargetProfile[];
  readonly environments: readonly MatchResult<string>[];
  /** lockfile 解析结果 */
  readonly dependencies: DependencySummary;
  readonly detectedAt: string;
  readonly lastConfirmedAt?: string;
  /** 漂移标记（见架构文档 §8） */
  readonly stale: boolean;
  /** 全量检测依据，可追溯、可展示 */
  readonly signals: readonly Signal[];
  /** 人工修正记录（永不丢失） */
  readonly overrides: UserOverrides;
}
