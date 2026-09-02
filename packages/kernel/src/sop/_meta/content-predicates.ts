/**
 * ContentInterpreter 的字段谓词集合 — 判断 SopRule.content 中存在哪类指令字段。
 *
 * 纯函数、无状态，从 ContentInterpreter 类抽出（门禁 mixed-responsibilities 治理，
 * zhcheck large-class: 21 方法超阈值 20）。
 */

export function hasToolDispatch(c: Record<string, unknown>): boolean {
  const check = c.check;
  return (
    typeof check === 'object' &&
    check !== null &&
    typeof (check as Record<string, unknown>).tool === 'string'
  );
}

export function hasChecks(c: Record<string, unknown>): boolean {
  return Array.isArray(c.checks) && c.checks.length > 0;
}

export function hasPatterns(c: Record<string, unknown>): boolean {
  return Array.isArray(c.patterns) && c.patterns.length > 0;
}

export function hasThresholds(c: Record<string, unknown>): boolean {
  return (
    typeof c.threshold === 'number' ||
    typeof c.threshold === 'string' ||
    (typeof c.thresholds === 'object' && c.thresholds !== null)
  );
}

export function hasForbidden(c: Record<string, unknown>): boolean {
  return Array.isArray(c.forbidden) && c.forbidden.length > 0;
}

export function hasLayers(c: Record<string, unknown>): boolean {
  return Array.isArray(c.layers) && c.layers.length > 0;
}

export function hasScanners(c: Record<string, unknown>): boolean {
  return Array.isArray(c.scanners) && c.scanners.length > 0;
}

export function hasPresets(c: Record<string, unknown>): boolean {
  return Array.isArray(c.presets) && c.presets.length > 0;
}

export function hasForbiddenRegex(c: Record<string, unknown>): boolean {
  const items = c.forbiddenRegex;
  return Array.isArray(items) && items.length > 0;
}

export function hasRequired(c: Record<string, unknown>): boolean {
  const items = c.required;
  return Array.isArray(items) && items.length > 0;
}
