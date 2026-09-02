/**
 * 自动更新错误分类/脱敏模块。
 *
 * 职责：
 * - 把 electron-updater 抛出的原始错误归类为稳定的错误码 + 通用文案；
 * - 保证任何原始错误信息（本地路径、仓库地址、网络细节等）**绝不跨 IPC
 *   进入渲染进程** —— 渲染端只拿到 { code, message }；
 * - 原始明细仅通过 describeError() 供主进程日志记录。
 *
 * 本模块刻意不依赖 electron / electron-updater，便于在 node 环境单测。
 */

export const UPDATE_ERROR_MESSAGES = {
  UPDATE_CHECK_FAILED: '暂时无法获取更新信息，请稍后重试。',
  UPDATE_DOWNLOAD_FAILED: '更新包下载失败，请检查磁盘空间或稍后重试。',
  UPDATE_SIGNATURE_INVALID: '更新包签名校验未通过，已阻止安装。请从官方渠道重新下载安装包。',
  UPDATE_NETWORK_ERROR: '网络连接异常，请检查网络后重试。',
  UPDATE_UNKNOWN: '更新服务暂时不可用，请稍后重试。',
} as const;

export type UpdateErrorCode = keyof typeof UPDATE_ERROR_MESSAGES;

export interface UpdateErrorInfo {
  readonly code: UpdateErrorCode;
  /** 渲染端可安全展示的通用文案（不含任何原始错误细节）。 */
  readonly message: string;
}

/** 原始错误信息 ── 仅允许出现在主进程日志，禁止跨 IPC 传输。 */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message || err.name;
  }
  if (typeof err === 'string') {
    return err;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

interface ClassifyRule {
  readonly code: Exclude<UpdateErrorCode, 'UPDATE_UNKNOWN'>;
  /** 命中即归类；按顺序评估，先签名校验后其它。 */
  readonly pattern: RegExp;
}

const CLASSIFY_RULES: readonly ClassifyRule[] = [
  {
    code: 'UPDATE_SIGNATURE_INVALID',
    // 签名 / 完整性校验失败；走 Apple 公证签名或 sha512 校验时报错均含此类关键词
    pattern: /signature|code.?sign|verify|integrity|sha512|checksum|corrupt|tamper/i,
  },
  {
    code: 'UPDATE_CHECK_FAILED',
    // 更新清单缺失/404：未打包（dev 模式无 app-update.yml）或发布渠道无元数据
    pattern: /app-update\.yml|404|not found|no release|update.*config/i,
  },
  {
    code: 'UPDATE_NETWORK_ERROR',
    // Chromium net:: 错误、DNS/连接/超时、fetch 网络层失败
    pattern: /net::|network|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|getaddrinfo|socket|request failed|fetch.*fail/i,
  },
  {
    code: 'UPDATE_DOWNLOAD_FAILED',
    // 磁盘 / 权限 / 写入失败（下载落盘阶段）
    pattern: /ENOSPC|EACCES|EPERM|EISDIR|EDQUOT|write.*fail|permission/i,
  },
];

/**
 * 把未知错误归类为稳定的错误码 + 通用文案。
 * 无法匹配时降级为 UPDATE_UNKNOWN（同样安全，文案不含细节）。
 */
export function classifyUpdateError(err: unknown): UpdateErrorInfo {
  const detail = describeError(err);
  for (const rule of CLASSIFY_RULES) {
    if (rule.pattern.test(detail)) {
      return { code: rule.code, message: UPDATE_ERROR_MESSAGES[rule.code] };
    }
  }
  return { code: 'UPDATE_UNKNOWN', message: UPDATE_ERROR_MESSAGES.UPDATE_UNKNOWN };
}