/**
 * 渲染目标：输出行缓冲 + 当前缩进
 *
 * 封装 (lines, indent) 参数泥团：各段落渲染方法只需携带数据 + 渲染目标，
 * 调用方构造一次即可逐层下传（行为不变，仅结构收敛）。
 */
export interface RenderTarget {
  readonly lines: string[];
  readonly indent: string;
}

/**
 * ConsoleReporterFormat — 终端 ANSI 颜色工具
 *
 * 别名导出：此前本文件与 console-color.ts 各持一份逐字相同的实现
 * （9 个 ANSI 常量 + 9 个着色方法，仅差字段名 enabled / color），
 * 现统一收敛到 console-color.ts 的单一实现，此处只保留历史导出名，
 * 使 ConsoleReporter / console-reporter-sections / console-reporter-rule-engine
 * 等调用点无需大范围改名。
 */
export { ConsoleColor as ConsoleReporterFormat } from './console-color';
