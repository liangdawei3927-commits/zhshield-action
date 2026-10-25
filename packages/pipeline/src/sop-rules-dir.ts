/**
 * 默认 SOP 规则目录解析（从 PipelineRunner 构造器提取，行为不变）。
 *
 * 指向内置规则模板（domain/action 层级 yml）。注：根目录 kernel/src/sop 已无
 * domain/action 一层，规则都在 presets/sop-templates 下，若指向 src/sop
 * 会加载到 0 条 → 体检 0 检查项 + 默认满分。运行于 dist 树时（打包后）用 kernel/dist
 * 的模板（构建会把 yml 一并拷贝），dev 走 src。
 */
import { resolve } from 'node:path';

export function resolveDefaultSopRulesDir(): string {
  return __dirname.includes('/dist/')
    ? resolve(__dirname, '..', '..', 'kernel', 'dist', 'sop', 'presets', 'sop-templates')
    : resolve(__dirname, '..', '..', 'kernel', 'src', 'sop', 'presets', 'sop-templates');
}
