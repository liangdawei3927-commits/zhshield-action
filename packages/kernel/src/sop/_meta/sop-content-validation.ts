import { TOOL_IDS } from '@zh/shared';
import { ContentInterpreter } from './content-interpreter';
import { isSafeRegexPattern } from '../../runner/scan-utils';
import type { SopRuleIssue } from './sop-field-validation';
import type { SopRule } from './sop-types';
import type { UnresolvedInstruction } from './rule-evaluation';

/**
 * SOP 规则 content 级校验 —— 补上「元数据字段对了、但检查内容跑不起来」这层。
 *
 * 与 `validateRuleSource` / `validateBuiltRule` 的分工：
 *   · 那两个管**元数据字段拼错**（status / domain / action / tags ...）
 *   · 本模块管 **content 里的检查指令能不能真跑起来**
 *
 * 实现取向：**直接消费 `ContentInterpreter` 的解释结果，不重写一套 content schema。**
 * 双真源必然漂移 —— 解释器改了判定而校验器没跟上时，校验会开始撒谎。
 *
 * 2026-10-29 实测云端缓存 52 条：45 条 `*.official.*`（全 active）+ 7 条 draft。
 * 解释分布：tool-dispatch 23 / check-list 9 / threshold 4 / layer-boundary 2 /
 * forbidden 2 / scanner-dispatch 2 / required-content 2 / preset 1 / **unresolved 7**。
 *
 * ⚠️ 那 7 条 unresolved **全部是 draft**（内容还没写，当前不执行）—— 所以本模块在
 * 现有数据上是 **0 拒收**（存量零误伤），它守的是两道**必然会被踩到**的坑：
 *   ① 服务端 `PUBLISHABLE_STATUSES = {draft, trial}` 允许 draft 直接发布，
 *      转 active 那一刻它们就变成"每次体检固定降级、零产出"的幽灵规则；
 *   ② 其中 `security.scan.internal.unused-file` 把工具名写在 content 顶层
 *      （`tool: ts-prune`），而解释器只认 `check.tool` ⇒ 即便转 active 也永不派发。
 */

/** 单条规则最多报告几个「未通过安全校验的正则」：避免一条坏规则刷满日志 */
const MAX_UNSAFE_REGEX_REPORTED = 5;

/**
 * 校验一条**已构建**规则的 content。
 *
 * @param rule    已构建的 SopRule（其 content 为整份规则文档）
 * @param locator 问题归因标识（`cloud-sync:{id}` / 文件路径）
 */
export function validateRuleContent(rule: SopRule, locator: string): SopRuleIssue[] {
  const raw = (rule.content ?? {}) as Record<string, unknown>;
  // 空 content = 内容还没写（draft 占位 / 测试工厂默认值），不是"写错了"。
  // 对它判 fatal 会把所有未完成的规则一并拒收，属于误伤。
  if (Object.keys(raw).length === 0) return [];

  const issues: SopRuleIssue[] = [];
  const instr = new ContentInterpreter().interpret(rule);

  if (instr.type === 'unresolved') {
    // 解释不了就不可能跑起来：后面的内部结构检查没有意义，直接返回
    issues.push(unresolvedIssue(raw, instr, locator, rule.status === 'active'));
    return issues;
  }

  if (instr.type === 'tool-dispatch') {
    const toolIssue = checkToolName(instr.tool, locator);
    if (toolIssue) issues.push(toolIssue);
  }

  if (instr.type === 'forbidden-regex') {
    issues.push(...unsafeRegexIssues(instr.items, locator));
  }

  // 整体条数由调用方（validateBuiltRule 的 push）统一按 MAX_ISSUES_PER_FILE 限流，
  // 这里不再二次限制 —— 两个限流常量并存必然漂移。
  return issues;
}

/**
 * content 无法解释为任何可执行指令。
 *
 * 定级依据：active 规则每次执行都落 degraded skipped（`runner.ts` 的 unresolved 分支
 * 显式设 degraded=true），既不产出检查结果，又让整轮体检的 `ok` 恒为 false。
 * 留它在 registry 里不是「能力」，是「每次体检固定增加一条降级」。
 *
 * 非 active（draft/trial/disabled）判 warn：内容未完成属正常阶段，
 * 拒收会把作者正在写的东西一并清掉。
 */
function unresolvedIssue(
  raw: Record<string, unknown>,
  instr: UnresolvedInstruction,
  locator: string,
  isActive: boolean,
): SopRuleIssue {
  const topLevelTool = raw.tool;

  // 高频写法错误单列：把工具名写在 content 顶层。解释器只认 check.tool，
  // 这种写法看起来"声明了工具"，实际永远不会被派发（实测云端 unused-file 即此例）。
  if (typeof topLevelTool === 'string' && topLevelTool.trim() !== '') {
    return {
      file: locator,
      field: 'content.tool',
      value: topLevelTool,
      level: isActive ? 'fatal' : 'warn',
      reason:
        `工具名写在 content 顶层（tool="${topLevelTool}"），而解释器只认 check.tool ⇒ ` +
        '该规则永远不会被派发。请改写为 check: { tool: ' + `"${topLevelTool}"` + ' }',
    };
  }

  const keys = instr.keys.length > 0 ? instr.keys.join(', ') : '<空>';
  return {
    file: locator,
    field: 'content',
    value: instr.keys,
    level: isActive ? 'fatal' : 'warn',
    reason:
      `无任何可执行指令段（顶层键：${keys}）。该规则每次执行都落 degraded skipped：` +
      '既不产出检查结果，又会让整轮体检恒为降级状态。',
  };
}

/**
 * tool-dispatch 的工具名检查。
 *
 * · 空字符串 ⇒ fatal（派发必然失败，等于没写）
 * · 不在 TOOL_IDS ⇒ warn（可能由外部适配器注册，判 fatal 会误杀；presets 存量 5 条即此形态）
 */
function checkToolName(tool: string, locator: string): SopRuleIssue | null {
  if (tool.trim() === '') {
    return {
      file: locator,
      field: 'content.check.tool',
      value: tool,
      level: 'fatal',
      reason: 'check 段声明了 tool 但取值为空，规则无法派发到任何适配器',
    };
  }
  if ((TOOL_IDS as readonly string[]).includes(tool)) return null;
  return {
    file: locator,
    field: 'content.check.tool',
    value: tool,
    level: 'warn',
    reason: `工具 "${tool}" 不在 TOOL_IDS 内：核心库里没有对应适配器，规则将落 unavailable（不产出结果）`,
  };
}

/**
 * forbidden-regex 中未通过安全校验的正则 ⇒ warn。
 *
 * `compileForbiddenRegexItems` 对 `isSafeRegexPattern` 不通过的正则**静默 continue**：
 * YAML 里明明写着检查项，运行期一条都不查且无日志 —— 「声明了却没执行」的典型形态。
 * 判 warn 而非 fatal：同一条规则里的其他检查项仍然有效，拒掉整条会白丢检出能力。
 */
function unsafeRegexIssues(
  items: ReadonlyArray<{ regex: string }>,
  locator: string,
): SopRuleIssue[] {
  const issues: SopRuleIssue[] = [];
  items.forEach((item, index) => {
    if (issues.length >= MAX_UNSAFE_REGEX_REPORTED) return;
    if (isSafeRegexPattern(item.regex)) return;
    issues.push({
      file: locator,
      field: `content.forbiddenRegex.items[${index}].regex`,
      value: item.regex,
      level: 'warn',
      reason: '正则未通过 isSafeRegexPattern 安全校验，该检查项在运行期会被静默跳过',
    });
  });
  return issues;
}
