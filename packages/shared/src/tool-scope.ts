/**
 * 工具执行面随画像裁剪（tool-scope.ts）
 *
 * 画像驱动工具下发的 scope 判定纯函数。供三条链路复用：
 * - 断点B：工具规则同步（WisdomBrainSync.syncAllRules(feature?)）按当前项目画像裁剪下发工具子集
 * - 断点D-direct：InspectEngine 直接扫描（ToolAdapterExecutor.runAll）跳过 scope 外适配器
 * - 断点D-SOP：SopRuleEngine 规则评估（dispatch-evaluators）裁剪 tool-dispatch 指令
 *
 * 与 @zh/kernel 的 ProjectFeature 结构兼容（kernel 不反向依赖 shared，
 * 本文件以结构最小投影为准，避免循环依赖）。
 */

/** 结构兼容的画像最小投影（与 kernel ProjectFeature: { framework?, language?, features[] } 对齐） */
export interface ScopeProfile {
  framework?: string;
  language?: string;
  features?: string[];
}

/**
 * 工具→画像条件映射。undefined / 命中返回 true（启用），未命中返回 false（裁剪）。
 *
 * 裁剪语义口径：
 * - security 域恒含（与 ruleMatchesProject 的 security 域恒命中一致）
 * - 语言相关工具（eslint / dep-cruiser / ts-prune / tsc）按 language 判断
 * - 其余工具（grype/gitleaks/ort/depcheck/jscpd/autoperf/sentinel/prettier/
 *   commit-lint/npm-audit/sonarway/trivy/semgrep）默认 true（无画像或工具特殊，保持全量兼容）
 */
const TOOL_SCOPE_MAP: Record<string, (feature?: ScopeProfile) => boolean> = {
  // ── security 域恒含 ──
  semgrep: () => true,
  trivy: () => true,
  grype: () => true,
  gitleaks: () => true,
  'npm-audit': () => true,
  // ── 语言相关：仅当语言命中或画像缺失（缺省全量）时启用 ──
  eslint: (f) => !f || f.language === 'typescript' || f.language === 'javascript',
  'dep-cruiser': (f) => !f || f.language === 'typescript' || f.language === 'javascript',
  'ts-prune': (f) => !f || f.language === 'typescript',
  tsc: (f) => !f || f.language === 'typescript',
};

/**
 * 判定某工具在当前画像下是否在 scope 内。
 *
 * @param toolId 工具 id（string 以便两个 ToolId 集合——kernel 4 值 / shared 17 值——通用）
 * @param feature 结构化画像最小投影；缺省 → 全部启用（保持全量兼容，与现有降级语义一致）
 */
export function isToolInScope(toolId: string, feature?: ScopeProfile): boolean {
  const checker = TOOL_SCOPE_MAP[toolId];
  return checker ? checker(feature) : true;
}

/**
 * 按画像过滤工具列表（供 SOP 双注册 / 直扫 runAll 的 adapter 列表裁剪）。
 *
 * @param tools 带 id 字段的工具/适配器列表
 * @param feature 画像；缺省 → 原样返回（不裁剪）
 */
export function filterToolsByProfile<T extends { id: string }>(
  tools: readonly T[],
  feature?: ScopeProfile,
): T[] {
  if (!feature) return [...tools];
  return tools.filter((t) => isToolInScope(t.id, feature));
}
