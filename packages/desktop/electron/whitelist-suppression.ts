/**
 * 白名单豁免（whitelist-suppression.ts）
 *
 * 把「已知问题被白名单接受」这一件事收在一个模块里，两个理由：
 *
 * 1. **单一真源**。主进程（ipc/engines-scanners）与 worker 进程（pipeline-jobs）
 *    两条链路都要做同一套过滤与挂载。各写一份必然漂移——一条过滤、另一条不过滤，
 *    用户就会看到「安全页没有、项目体检却有」的同一处问题。
 * 2. **职责边界**。白名单过滤既不属于「报告类型转换」（report-format），
 *    也不属于「诊断落盘」（zh-diagnostics-persist）；留在任一文件里都会把那个文件
 *    顶破 400 行阈值。这里只放豁免判定与展示数据的整理，不碰 I/O 以外的逻辑。
 *
 * 依赖方向：本模块 → @zh/guard 的 WhitelistManager（只读）。不反向依赖任何 IPC 层。
 */

import { WhitelistManager } from '@zh/guard';
import type { DiagnosticEntry } from './zh-diagnostics-types';

/** 被白名单压制的一条问题：连同命中条目一起带出 */
export interface SuppressedDiagnostic {
  /** 被压制的问题条目 */
  entry: DiagnosticEntry;
  /** 豁免理由 */
  reason: string;
  /** 责任人 */
  operator: string;
  /** 到期时间（ISO）；缺省视为永久 */
  expiresAt?: string;
}

/** 白名单过滤结果：保留项 + 被豁免项（两者都要用，故不只返回数组） */
export interface WhitelistFilterResult {
  kept: readonly DiagnosticEntry[];
  suppressed: readonly SuppressedDiagnostic[];
}

/**
 * 豁免条目的**展示投影**：报告要回传渲染层，只需这五个字段。
 *
 * 单独定义而不是让渲染层拿 `SuppressedDiagnostic`：后者带整个 `DiagnosticEntry`
 * （含 fingerprint / category / autoFixable 等页面用不到的内部字段），
 * 跨进程回传时既增体积又把内部结构固化进 IPC 契约。
 */
export interface SuppressedDisplay {
  /** 规则 ID */
  ruleId: string;
  /** 问题描述（页面截断展示） */
  message: string;
  /** 豁免理由 */
  reason: string;
  /** 责任人 */
  operator: string;
  /** 到期时间（ISO）；缺省 = 永久 */
  expiresAt?: string;
}

/** `SuppressedDiagnostic` → 展示投影（一处转换，主进程与 worker 共用） */
export function toSuppressedDisplay(s: SuppressedDiagnostic): SuppressedDisplay {
  return {
    ruleId: s.entry.ruleId,
    message: s.entry.message,
    reason: s.reason,
    operator: s.operator,
    ...(s.expiresAt ? { expiresAt: s.expiresAt } : {}),
  };
}

/**
 * 按已加载的白名单过滤条目。
 *
 * **不能要求条目必须有 file**：配置类检查（安全头 / 密钥轮换 / KMS 集中管理等
 * check-list 项）由 `@zh/kernel` 的 dispatch-check-list 产出，file 恒为空字符串。
 * 旧实现写作 `entry.file && whitelist.isWhitelisted(...)`，这半句短路让
 * `whitelist.project`（按规则身份全项目压制、本就不需要文件）永远命中不了，
 * 于是「项目级接受风险声明」形同虚设（2026-11-14 实测：KMS 条目白名单不生效）。
 *
 * 传空 file 后各作用域的语义仍然正确：file/rule 作用域要 `includes(target)`，
 * 空串只在 target 为空时命中（没人会这么写）；project 作用域只比规则身份。
 */
export function filterWhitelisted(
  whitelist: WhitelistManager,
  entries: readonly DiagnosticEntry[],
): WhitelistFilterResult {
  const kept: DiagnosticEntry[] = [];
  const suppressed: SuppressedDiagnostic[] = [];
  for (const entry of entries) {
    const hit = whitelist.isWhitelisted(entry.ruleId, entry.file ?? '');
    if (hit.whitelisted) {
      suppressed.push({
        entry,
        reason: hit.entry?.reason ?? '',
        operator: hit.entry?.operator ?? 'config',
        ...(hit.entry?.expiresAt ? { expiresAt: hit.entry.expiresAt } : {}),
      });
      continue;
    }
    kept.push(entry);
  }
  return { kept, suppressed };
}

/**
 * 读白名单并过滤：把「加载 + 过滤」收成一次调用，供**出分前**使用。
 *
 * 存在的理由是一个真实缺陷（2026-11-14 实测）：`runSecurityHandler` 先用
 * **未过滤**的条目算了 dimensionScore、再落盘时过滤白名单。于是即使条目被豁免，
 * 96.4 分也原封不动 —— 用户看到的仍是「检查完成 96.4 分 · 1 个中危」，
 * 豁免只让明细少一行，等于没生效。分数与条目必须**同源**：先过滤，再用过滤后的
 * 条目出分，两者才不可能漂移。
 *
 * 读取失败（无 whitelist.yml / 损坏）降级为空过滤，保持原行为，不阻断扫描。
 */
export async function applyWhitelistFilter(
  projectPath: string,
  entries: readonly DiagnosticEntry[],
): Promise<WhitelistFilterResult> {
  const whitelist = new WhitelistManager(projectPath);
  await whitelist.load();
  return filterWhitelisted(whitelist, entries);
}
