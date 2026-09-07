import type { SopRule, ProjectFeature } from './sop-types';

/**
 * 语言与框架 token 构成"栈限定标签"。
 * 规则只有携带栈限定标签时，才可能因画像不匹配而被裁剪；
 * 无栈限定标签的规则（如 commit-message、duplication、complexity、architecture…）
 * 视为通用规则，对任意项目都保留。
 */
const STACK_TAGS: ReadonlySet<string> = new Set([
  // 语言
  'typescript',
  'javascript',
  'python',
  // 框架
  'nestjs',
  'react',
  'vue',
  'next',
  'nextjs',
  'express',
  'fastify',
  'electron',
  'koa',
  'svelte',
  'angular',
  'django',
  'fastapi',
  'flask',
  'tornado',
]);

/**
 * 项目画像的栈集合（framework / language / features，统一小写便于与 tags 比较）。
 */
function projectStack(feature: ProjectFeature): ReadonlySet<string> {
  const stack = new Set<string>();
  if (feature.framework) stack.add(feature.framework.toLowerCase());
  if (feature.language) stack.add(feature.language);
  for (const f of feature.features ?? []) stack.add(f.toLowerCase());
  return stack;
}

/**
 * 纯数据谓词：规则是否属于某项目画像。
 * 从 SopLoader.matchesProject 抽取为独立模块，供 loader 与规则引擎共用，
 * 保证"按画像过滤"的服务端 / 客户端判定口径完全一致。
 *
 * 判定口径（保守，倾向不裁剪）：
 *  - security 域恒命中（所有项目都必须安全治理）；
 *  - 规则不携带任何栈限定标签 → 通用规则，恒保留；
 *  - 携带栈限定标签，且命中项目栈任一元素 → 保留；
 *  - 携带栈限定标签，但完全不匹配项目栈（属于其它技术栈独占）→ 裁剪。
 * 这样即便项目画像探测不到非根目录子包的框架（如 monorepo），
 * 也只会裁剪明确属于其它栈的规则，而不会误伤通用治理规则。
 */
export function ruleMatchesProject(rule: SopRule, feature: ProjectFeature): boolean {
  if (rule.domain === 'security') return true;
  const tags = rule.tags ?? [];
  const stackTags = tags.filter((t) => STACK_TAGS.has(t));
  if (stackTags.length === 0) return true;
  return stackTags.some((t) => projectStack(feature).has(t));
}
