import type { LanguageCode } from '@zh/i18n';

/**
 * Reporter 输出格式选项
 */
export interface ReportFormatOptions {
  /** 是否显示颜色 */
  color?: boolean;

  /** 是否显示详细信息（违规详情、文件列表） */
  verbose?: boolean;

  /** 目标语言；缺省使用 @zh/i18n 进程级单例的当前语言 */
  lang?: LanguageCode;
}

/**
 * 格式化后的报告字符串
 */
export interface FormattedReport {
  /** 文本报告 */
  text: string;

  /** 是否通过 */
  passed: boolean;
}

/**
 * 报告内部翻译函数：目录 key → 当前语言字符串
 * （显式 lang 时用 translate，否则走进程级单例 t）
 */
export type TranslateFn = (key: string, params?: Record<string, unknown>) => string;
