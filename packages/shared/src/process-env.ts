/**
 * 环境变量基础净化（process-env.ts）
 *
 * 目标：子进程（ESLint / Semgrep / npm / 测试命令等）只继承最小必要的
 * 环境变量，避免宿主机的 TOKEN / KEY / SECRET 等敏感配置被下游工具读取、
 * 记录或外传。
 *
 * 策略：白名单复制 —— 只保留基础运行变量 + 业务前缀（npm_ / NODE_ /
 * pnpm_ / ZH_），再对保留项做一轮敏感模式剔除。
 */

/** 始终保留的基础变量 */
const BASE_ALLOWLIST = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'LC_NUMERIC',
  'LC_TIME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SHELL',
  'USER',
  'LOGNAME',
  'PWD',
  'TERM',
  'CI',
  'NO_COLOR',
  'FORCE_COLOR',
  'EDITOR',
  'VISUAL',
  'JAVA_HOME',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'NODE_ENV',
] as const;

/** 按前缀放行的业务配置（npm registry / node 选项 / 产品配置等） */
const PREFIX_ALLOWLIST = ['npm_', 'NODE_', 'pnpm_', 'PNPM_', 'ZH_', 'corepack_'];

/** 敏感键名模式：命中即剔除（无论是否在白名单前缀内） */
const SENSITIVE_PATTERNS: RegExp[] = [
  /token/i,
  /secret/i,
  /pass(word|wd)?/i,
  /credential/i,
  /api[_-]?key/i,
  /access[_-]?key/i,
  /private[_-]?key/i,
  /_auth/i,
  /ssh[a-z_]*sock/i,
];

/** 判断某个键名是否命中敏感模式 */
function isSensitiveKey(key: string): boolean {
  return SENSITIVE_PATTERNS.some((re) => re.test(key));
}

/**
 * 返回净化后的环境变量副本。
 *
 * @param env      原始环境（默认 process.env）
 * @param overrides 额外注入的变量（如 CI: 'true'），覆盖同名单选保留项
 */
export function sanitizeEnv(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};

  // 1. 基础白名单
  for (const key of BASE_ALLOWLIST) {
    const value = env[key];
    if (value !== undefined) result[key] = value;
  }

  // 2. 业务前缀（剔除敏感项）
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (!PREFIX_ALLOWLIST.some((prefix) => key.startsWith(prefix))) continue;
    if (isSensitiveKey(key)) continue;
    result[key] = value;
  }

  // 3. 显式覆盖
  for (const [key, value] of Object.entries(overrides)) {
    result[key] = value;
  }

  return result;
}
