import * as path from 'node:path';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { GOVERNANCE_DOMAINS } from '@zh/shared';

/** SopLoader 扫描的治理域目录（与 kernel SopRuleFileCollector 同源：@zh/shared） */
const DOMAIN_DIRS: ReadonlySet<string> = new Set<string>(GOVERNANCE_DOMAINS);

/** 路径存在且是目录。existsSync 对文件同样返回 true，直接透传给 readdirSync
 *  会抛 ENOTDIR 让 CLI 启动崩溃——非目录一律按"不存在"处理，交由调用方回退。 */
function isDirectory(p: string): boolean {
  return existsSync(p) && statSync(p).isDirectory();
}

/** 随 bundle 打包的 SOP 规则目录（build-cli.mjs 复制 kernel/src/sop → dist/sop）。
 *  优先返回 presets/sop-templates（SopLoader 扫描 {domain}/{action} 两级目录下的规则文件，
 *  域目录 guard/inspect/security/sentinel/evolve 位于其下）；
 *  兼容旧布局（域目录直接位于 sop/ 一级）时回退到 sop/ 本身；
 *  均不存在时返回 undefined，由调用方回退到 @zh/pipeline 的 monorepo 默认路径。 */
export function resolveBundledSopDir(base: string): string | undefined {
  const bundled = path.join(base, 'sop');
  if (!isDirectory(bundled)) return undefined;
  const templates = path.join(bundled, 'presets', 'sop-templates');
  if (isDirectory(templates)) return templates;
  const hasLegacyDomains = readdirSync(bundled, { withFileTypes: true }).some(
    (entry) => entry.isDirectory() && DOMAIN_DIRS.has(entry.name),
  );
  return hasLegacyDomains ? bundled : undefined;
}
