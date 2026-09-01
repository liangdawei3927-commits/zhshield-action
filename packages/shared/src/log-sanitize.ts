// ─── 日志字段净化（防日志注入）────────────────────────

/** 日志字段最大长度（防止超长字段撑爆日志） */
export const MAX_LOG_FIELD_LENGTH = 512;

/**
 * 净化日志插值字段：剥离换行 / 回车并限制长度。
 *
 * 日志注入攻击通过向字段中注入 `\n` / `\r` 伪造日志行或绕过审计。
 * 所有进入日志模板的不可信字段必须先经过本函数，再作为参数传入
 * 常量模板（绝不可作为 util.format / console.* 的格式串）。
 */
export function sanitizeLogField(value: unknown): string {
  return String(value)
    .replace(/[\r\n]/g, ' ')
    .slice(0, MAX_LOG_FIELD_LENGTH);
}
