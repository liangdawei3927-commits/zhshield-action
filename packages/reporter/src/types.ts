/**
 * Reporter 输出格式选项
 */
export interface ReportFormatOptions {
  /** 是否显示颜色 */
  color?: boolean;

  /** 是否显示详细信息（违规详情、文件列表） */
  verbose?: boolean;
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
 * 翻译函数类型：由 i18n 层注入，格式化器只依赖此抽象
 */
export type TranslateFn = (key: string, values?: Record<string, unknown>) => string;
