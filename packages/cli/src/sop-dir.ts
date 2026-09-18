import * as path from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { GOVERNANCE_DOMAINS } from '@zh/shared';

/** SopLoader 扫描的治理域目录（与 kernel SopRuleFileCollector 同源：@zh/shared） */
const DOMAIN_DIRS: ReadonlySet<string> = new Set<string>(GOVERNANCE_DOMAINS);

/** 随 bundle 打包的 SOP 规则目录（build-cli.mjs 复制 kernel/src/sop → dist/sop）。
 *  优先返回 presets/sop-templates（SopLoader 扫描 {domain}/{action} 两级目录下的规则文件，
 *  域目录 guard/inspect/security/sentinel/evolve 位于其下）；
 *  兼容旧布局（域目录直接位于 sop/ 一级）时回退到 sop/ 本身；
 *  均不存在时返回 undefined，由调用方回退到 @zh/pipeline 的 monorepo 默认路径。 */
export function resolveBundledSopDir(base: string): string | undefined {
  const bundled = path.join(base, 'sop');
  if (!existsSync(bundled)) return undefined;
  const templates = path.join(bundled, 'presets', 'sop-templates');
  if (existsSync(templates)) return templates;
  const hasLegacyDomains = readdirSync(bundled, { withFileTypes: true }).some(
    (entry) => entry.isDirectory() && DOMAIN_DIRS.has(entry.name),
  );
  return hasLegacyDomains ? bundled : undefined;
}
