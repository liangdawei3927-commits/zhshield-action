/**
 * `zhshield capability` — 检测能力矩阵（声明 vs 实际）。
 *
 * ## 为什么要有这个命令
 *
 * 2026-11-02 实测发现的断裂：同一份夹具、同一台机器，
 *   · CLI `inspect --sop` → `security.scan.semgrep.sql-injection` **检出 1 条**
 *   · 桌面安全中心 → **0 检出**，且 `status='ok'`、`degraded=undefined`
 *
 * 用户看到的是「安全页说一切正常」，而真相是「那 7 条规则一次都没被执行」。
 * 报告里没有任何异常提示 —— 这正是本项目最忌讳的「把没检测显示成很干净」。
 *
 * 本命令把这件事变成**可见的、可 CI 门禁的事实**：
 * 打印每个域「声明了多少条 / 实际会执行多少条」，并列出所有断链明细及其原因。
 *
 * ## 退出码
 *
 *   0 = 无 active 断链（所有 active 规则都会真的被执行）
 *   2 = 存在 active 断链 —— **事实与宣称不符**，CI 应失败
 *
 * 判据只看「active 但永远不会执行」的规则。非 active（draft / trial）是规则的
 * 正常生命周期状态，不拦。
 *
 * ## 输出形态
 *
 * `--format json` 时输出机器可读结构（CI 消费）；默认输出人类可读表格。
 */

import { auditCapabilityClosure, isClosureAcceptable } from '@zh/kernel';
import type { CapabilityClosureReport } from '@zh/kernel';
import { CAPABILITY_REGISTRY } from '@zh/shared';
import type { CapabilityDeclaration } from '@zh/shared';
import type { PipelineRunner } from '@zh/pipeline';
import type { CLIOptions } from './cli-options';

/** 人类可读的表格输出 */
function formatText(report: CapabilityClosureReport): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('检测能力矩阵（声明 vs 实际）');
  lines.push('='.repeat(72));
  lines.push(
    `声明 ${report.declaredTotal} 条 | active ${report.activeTotal} 条 | ` +
      `实际生效 ${report.effectiveTotal} 条 | 断链 ${report.brokenTotal} 条`,
  );
  lines.push('');
  lines.push('域          执行路径              声明  生效  断链');
  lines.push('-'.repeat(72));
  for (const d of report.domains) {
    lines.push(
      `${d.domain.padEnd(12)} ${d.path.padEnd(20)} ${String(d.declared).padStart(4)}  ` +
        `${String(d.effective).padStart(4)}  ${String(d.broken).padStart(4)}`,
    );
  }

  if (report.breaks.length > 0) {
    lines.push('');
    lines.push('断链明细（active 但永远不会执行）：');
    lines.push('-'.repeat(72));
    for (const b of report.breaks) {
      lines.push(`  ✗ ${b.ruleId}`);
      lines.push(`    原因：${b.breakReason}`);
      lines.push(`    说明：${b.detail ?? '(无)'}`);
    }
  } else {
    lines.push('');
    lines.push('✓ 无断链：所有 active 规则都会真的被执行');
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * 执行 `capability` 命令。
 *
 * @param runner 已装载规则的 runner（内置 + 云同步）
 * @param opts   CLI 选项（`--format json` / `--report <path>`）
 */
export async function runCapabilityCommand(
  runner: PipelineRunner,
  opts: CLIOptions,
): Promise<void> {
  const report = auditCapabilityClosure(runner.getSopRules());

  if (opts.format === 'json') {
    const payload = `${JSON.stringify(
      {
        ...report,
        unimplementedCapabilities: CAPABILITY_REGISTRY.filter((c) => c.status !== 'implemented'),
      },
      null,
      2,
    )}\n`;
    if (opts.report) {
      const { writeFileSync, mkdirSync } = await import('node:fs');
      const { dirname, resolve } = await import('node:path');
      const abs = resolve(opts.report);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, payload, 'utf-8');
      console.error(`[CLI] 能力矩阵已写入: ${opts.report}`);
    } else {
      process.stdout.write(payload);
    }
  } else {
    console.log(formatText(report));
    console.log(formatCapabilityGaps());
    console.log('');
  }

  if (!isClosureAcceptable(report)) {
    console.error(
      `[CLI] 能力闭环断裂：${report.brokenTotal} 条 active 规则永远不会执行 — ` +
        '宣称的能力没有对应实现（未检测 ≠ 通过）。修复前不应发版。',
    );
    process.exitCode = 2;
  }
}

/**
 * 未实现能力清单（UI 不得宣称的部分）。
 *
 * 与「规则断链」互补：规则断链是「声明了规则但跑不到」，
 * 这里是「声明了能力但没实现」—— 后者正是 UI 宣称超载的来源
 * （性能页 ReDoS / 现代化 API / 定时器、安全页规范检查、垃圾页重复代码）。
 *
 * 这份清单**不是错误**，只是「尚未做」的诚实记录 —— 它不会让命令失败。
 * 它的价值在于：任何人想加能力时，能看到「这件事已经登记为 planned，
 * 实现完把它改成 implemented 即可，UI 会自动显示」。
 */
function formatCapabilityGaps(): string {
  const lines: string[] = [];
  const unimplemented = CAPABILITY_REGISTRY.filter((c) => c.status !== 'implemented');
  if (unimplemented.length === 0) {
    lines.push('✓ 无未实现能力：所有登记能力都已落地');
    return lines.join('\n');
  }
  lines.push(`未实现能力（${unimplemented.length} 项，UI 不得宣称）：`);
  lines.push('-'.repeat(72));
  const byDomain = new Map<string, CapabilityDeclaration[]>();
  for (const cap of unimplemented) {
    const list = byDomain.get(cap.domain) ?? [];
    list.push(cap);
    byDomain.set(cap.domain, list);
  }
  for (const [domain, caps] of byDomain) {
    lines.push(`  ${domain}:`);
    for (const cap of caps) {
      lines.push(`    · [${cap.status}] ${cap.label}`);
      if (cap.note) lines.push(`        ${cap.note}`);
    }
  }
  return lines.join('\n');
}
