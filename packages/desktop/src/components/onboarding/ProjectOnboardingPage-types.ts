// 项目引导页类型定义

/** 引导页组件入参：项目名/路径、完成与关闭回调、是否开启智能能力 */
export interface ProjectOnboardingPageProps {
  projectName: string;
  projectPath: string;
  onComplete: () => void;
  onClose?: () => void;
  intelligentEnabled?: boolean;
}

/** 画像确认面板展示用投影（来自 engine:runProfile 的 fingerprint ProjectProfile） */
export interface OnboardingProfileSummary {
  language?: string;
  framework?: string;
  architecture?: string;
  /** 探测置信度 0-1（主语言判定），低于 0.6 时 UI 提示人工核对 */
  confidence?: number;
}

/** 云端规则差量同步摘要（/resolve/rules 结果） */
export interface RuleSyncSummary {
  ok: boolean;
  total: number;
  changedCount: number;
}

/** 工具就绪探测结果（tools:status；工具半自动原则的面板数据源） */
export interface ToolsStatusSummary {
  source: 'cloud' | 'local';
  tools: Array<{
    toolId: string;
    status: 'project' | 'path' | 'shared' | 'missing';
    bin: string | null;
  }>;
}

/** 低置信度阈值：低于此值确认面板需提示人工核对（对齐 06-多语言自适应架构 §七） */
export const LOW_CONFIDENCE_THRESHOLD = 0.6;

/** 引导步骤：步骤 id、i18n 文案键、执行体与图标 */
export interface Step {
  id: string;
  labelKey: string;
  execute: () => Promise<void>;
  icon: JSX.Element;
}

/** 构建步骤列表所需参数：项目路径、模板确认状态与三个结果回调 */
export interface BuildStepsParams {
  projectPath: string;
  presetConfirmed: boolean;
  selectedPreset: string | null;
  profileDetected: boolean;
  profileConfirmed: boolean;
  onProfileDetected: (summary: OnboardingProfileSummary | null) => void;
  onRuleSyncResult: (summary: RuleSyncSummary) => void;
  onToolsStatus: (status: ToolsStatusSummary | null) => void;
}

/** 执行当前步骤所需参数：步骤列表、当前下标、三项确认状态与完成回调 */
export interface RunCurrentStepParams {
  steps: Step[];
  index: number;
  presetConfirmed: boolean;
  profileDetected: boolean;
  profileConfirmed: boolean;
  onDone: () => void;
}

/** 步骤推进 hook 的入参：步骤列表、三项确认状态与完成回调 */
export interface UseStepAdvanceParams {
  steps: Step[];
  presetConfirmed: boolean;
  profileDetected: boolean;
  profileConfirmed: boolean;
  onComplete: () => void;
}

export const ONBOARDING_PRESETS = [
  { id: 'nestjs-backend', label: 'NestJS 后端模板', desc: 'Node.js / TypeScript', icon: '🔧' },
  { id: 'frontend-standard', label: '前端标准模板', desc: 'React / Vue / TypeScript', icon: '🎨' },
  { id: 'general-purpose', label: '通用配置模板', desc: '所有项目类型', icon: '⚙️' },
];

/** 引导中央舞台透传给步骤层的全部参数（OnboardingCenter 与 OnboardingSteps 共用同一形状） */
export type OnboardingStageProps = {
  steps: Step[];
  completedSteps: Set<number>;
  currentStepIndex: number;
  t: (key: string, params?: Record<string, unknown>) => string;
  showPreset: boolean;
  selectedPreset: string | null;
  onSelectPreset: (id: string) => void;
  onConfirmPreset: () => void;
  showConfirm: boolean;
  profileSummary: OnboardingProfileSummary | null;
  onConfirmProfile: () => void;
  ruleSyncSummary: RuleSyncSummary | null;
  toolsStatus: ToolsStatusSummary | null;
  onRefreshTools: () => Promise<void>;
};

/** 工具行状态取值：从 ToolsStatusSummary 的单项 status 派生 */
export type ToolRowStatus = ToolsStatusSummary['tools'][number]['status'];
/** 翻译函数签名：key + 可选插值参数 → 本地化文案 */
export type TFunc = (key: string, params?: Record<string, unknown>) => string;
