/**
 * `--domains` 的解析与适用性校验（从 commands.ts 拆出，避免单个命令文件越过行数阈值）。
 *
 * 设计要点：**不认识就报错，不静默忽略**。漏掉的域一旦被当成"跑过了"，就是《07》C4
 * 明令禁止的假通过；而 `--domains` 用在根本不按域过滤的命令上，同样会让人误以为
 * "只跑了子集"。两种情形都显式失败，而不是给个好听的默认值。
 */
import type { DomainRunOptions } from '@zh/pipeline';
import { STATIC_SCAN_DOMAINS } from '@zh/pipeline';
import type { GovernanceDomain } from '@zh/shared';
import { INSPECT_SCOPE_DOMAINS } from '@zh/shared';
import type { CLIOptions } from './cli-options';

/** `--sop` 链路能服务的域：SOP 引擎只求值 INSPECT_SCOPE_DOMAINS（guard 走独立阶段） */
export const SOP_DOMAIN_HINT = '（SOP 链路只求值这些域；deps/performance 等域请用 --full）';

/**
 * 解析 `--domains a,b,c`。返回 `null` 表示"指定了但非法"（调用方负责 exit 1）。
 * `allowed` 缺省为全量扫描链的域集。
 */
export function parseDomainList(
  raw: string,
  allowed: readonly string[] = STATIC_SCAN_DOMAINS,
  hint = '',
): DomainRunOptions['domains'] | null {
  const names = raw
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (names.length === 0) {
    console.error('[CLI] --domains 需要至少一个域名，例如 --domains deps,security');
    return null;
  }
  const known = new Set<string>(allowed);
  const unknown = names.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    // 不静默忽略：漏掉的域会被当成"跑过了"，正是 C4 禁止的假通过
    console.error(
      `[CLI] 未知${hint ? '或该链路不支持的' : ''}域名: ${unknown.join(', ')}；可选: ${allowed.join(', ')}`,
    );
    return null;
  }
  return [...new Set(names)] as DomainRunOptions['domains'];
}

/**
 * `--domains` 只对**域驱动**的两条链路有意义：`--full`（域执行器链）与 `--sop`
 * （SOP 规则按域过滤）。其余命令静默忽略会让人以为"只跑了子集"，故显式拒绝。
 */
export function domainsMisapplied(opts: CLIOptions): boolean {
  if (!opts.domains) return false;
  if (opts.full || opts.sop) return false;
  console.error('[CLI] --domains 只与 --full（域驱动扫描）或 --sop（SOP 规则按域过滤）合用');
  process.exitCode = 1;
  return true;
}

/**
 * 把已按 `INSPECT_SCOPE_DOMAINS` 校验过的域名收窄到 `GovernanceDomain`。
 * 用类型谓词而不是 `as`：校验是运行时事实，但类型收窄也要由代码表达，不做无检查断言。
 */
export function asGovernanceDomains(domains: readonly string[]): GovernanceDomain[] {
  const allowed = new Set<string>(INSPECT_SCOPE_DOMAINS);
  return domains.filter((domain): domain is GovernanceDomain => allowed.has(domain));
}
