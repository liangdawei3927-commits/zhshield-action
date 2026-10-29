/**
 * 布尔型环境开关的统一解析。
 *
 * 为什么单独一个文件：`ZH_GATE_REQUIRE_SOP`（门禁严格模式）与
 * `ZH_SOP_ALLOW_UNSIGNED`（放行未签名规则）是同一类开关，但此前各写一份
 * `=== '1' || === 'true' || === 'yes'`。两处口径一旦漂移（有人补个 `on`、
 * 有人忘了 `yes`），同一个 `=1` 在不同开关上表现不同，排查成本极高。
 *
 * 未设置 / 空串 / 其它值一律 false —— 开关的默认方向必须是「不动用特权」。
 */
const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/** 读取布尔开关；未设置或非法值返回 false */
export function readBooleanEnv(env: NodeJS.ProcessEnv, key: string): boolean {
  const raw = env[key]?.trim().toLowerCase();
  return raw !== undefined && TRUTHY.has(raw);
}
