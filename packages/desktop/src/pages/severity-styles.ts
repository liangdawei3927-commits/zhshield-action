/** 通用严重级别视觉样式（high / medium / low）。
 *
 *  供 sentinel / guard 等页面复用；字段：`textKey`（i18n 键）、`color`、`bg`。
 *  仅收录在多个页面间**逐字一致**的三个级别；critical / info 各页取值不同，故不纳入。 */
export const SEVERITY_STYLES: Record<
  string,
  { textKey: string; color: string; bg: string }
> = {
  high: { textKey: 'severity.high', color: 'rgb(var(--zh-danger))', bg: 'rgb(var(--zh-danger) / 0.1)' },
  medium: {
    textKey: 'severity.medium',
    color: 'rgb(var(--zh-warning))',
    bg: 'rgb(var(--zh-warning) / 0.1)',
  },
  low: { textKey: 'severity.low', color: 'rgb(var(--zh-info))', bg: 'rgb(var(--zh-info) / 0.1)' },
};
