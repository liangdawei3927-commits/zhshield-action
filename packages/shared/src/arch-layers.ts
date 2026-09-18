/**
 * 架构分层规则 — 跨域单一来源（T8 口径统一）
 *
 * 同一处层间违规，在「门禁」（提交时拦住）与「项目体检」（全面治理）必须给出
 * **相同结论**。此前两处各写一份：门禁适配器内联 4 层 rank 模型，体检规则内联
 * 7 层 allowlist 模型，同一份代码两边结论可能不同。现把层级定义收敛为唯一一份
 * ——本模块。
 *
 * 消费方：
 * - `@zh/guard` 的 ArchitectureBoundaryAdapter（门禁页 ARCH-001）
 * - kernel 的 `layer-boundary` 内联评估器（读规则 YAML 的 `check.layers`）
 *
 * 语义：层名即目录名（IronNest 分层），**allowlist** —— 只允许显式列出的依赖方向。
 * 未按目录分层 / 未命中任何层名的文件不产生结论（跳过，不误报）。
 *
 * 防漂移：两份规则 YAML 的 `check.layers` 块必须与本表逐字一致，由
 * `kernel/src/__tests__/arch-layers-parity.test.ts` 与
 * `sop-presets-interpretable.test.ts` 共同锁定。
 */
export interface ArchLayer {
  name: string;
  allowedDependencies: string[];
}

export const CLEAN_ARCH_LAYERS: readonly ArchLayer[] = [
  { name: 'controllers', allowedDependencies: ['services', 'use-cases', 'dto'] },
  { name: 'use-cases', allowedDependencies: ['services', 'domain', 'dto'] },
  { name: 'services', allowedDependencies: ['domain', 'repositories', 'adapters', 'shared'] },
  { name: 'repositories', allowedDependencies: ['domain', 'shared'] },
  { name: 'adapters', allowedDependencies: ['domain', 'shared', 'core'] },
  { name: 'domain', allowedDependencies: ['shared'] },
  { name: 'shared', allowedDependencies: [] },
];

/** 层扫描时跳过的目录名：依赖、构建产物、版本控制等 */
export const ARCH_LAYER_EXCLUDED_DIRS: readonly string[] = [
  'node_modules',
  'dist',
  'build',
  '.git',
  '.turbo',
  '.next',
  'coverage',
];

/** 层扫描默认排除的路径 glob（测试/声明/产物文件） */
export const ARCH_LAYER_EXCLUDE_PATTERNS: readonly string[] = [
  '**/*.spec.ts',
  '**/*.test.ts',
  '**/*.d.ts',
  '**/generated/**',
  '**/node_modules/**',
  '**/dist/**',
  '**/coverage/**',
];

/** 按层名查允许依赖；层名不存在时返回 undefined（调用方据此判违规） */
export function allowedDependenciesOf(
  layerName: string,
  layers: readonly ArchLayer[] = CLEAN_ARCH_LAYERS,
): string[] | undefined {
  return layers.find((layer) => layer.name === layerName)?.allowedDependencies;
}

/** 依赖方向是否被允许：目标层未被任何层声明时视为允许（避免误报） */
export function isLayerDependencyAllowed(
  fromLayer: string,
  toLayer: string,
  layers: readonly ArchLayer[] = CLEAN_ARCH_LAYERS,
): boolean {
  const allowed = allowedDependenciesOf(fromLayer, layers);
  if (allowed === undefined) return true;
  return allowed.includes(toLayer);
}
