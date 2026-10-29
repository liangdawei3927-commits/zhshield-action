import { TOOL_IDS } from '@zh/shared';
import { ContentInterpreter, resolveInstructionScope } from './content-interpreter';
import { isSafeRegexPattern } from '../../runner/scan-utils';
import { readRuleSemantics, ENGINE_MEASURABLE_METRICS } from '../../runner/post-scan-gate';
import type { SopRuleIssue } from './sop-field-validation';
import type { SopRule } from './sop-types';
import type { ThresholdInstruction, UnresolvedInstruction } from './rule-evaluation';

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

  if (instr.type === 'threshold') {
    issues.push(...thresholdIssues(instr, raw, locator, rule.status === 'active'));
    const coverage = unmeasurableThresholdIssue(rule, instr, locator);
    if (coverage) issues.push(coverage);
  }

  if (instr.type === 'forbidden-regex') {
    const shapeIssue = forbiddenRegexShapeIssue(instr.items.length, raw, locator);
    if (shapeIssue) issues.push(shapeIssue);
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
 * forbidden-regex 的结构检查：声明了数组，但每一条都缺字符串字段 `regex`。
 *
 * 解释器 `toForbiddenRegex` 用 filter 丢掉非法条目后不报错 ⇒ items 变空数组 ⇒
 * 评估恒 0 命中、判通过的「声明了却没执行」。
 */
function forbiddenRegexShapeIssue(
  validCount: number,
  raw: Record<string, unknown>,
  locator: string,
): SopRuleIssue | null {
  if (validCount > 0) return null;
  const declared = resolveInstructionScope(raw).forbiddenRegex;
  const declaredCount = Array.isArray(declared) ? declared.length : 0;
  if (declaredCount === 0) return null;
  return {
    file: locator,
    field: 'content.forbiddenRegex',
    value: declared,
    level: 'warn',
    reason:
      `声明了 ${declaredCount} 条 forbiddenRegex，但没有一条含字符串字段 regex，` +
      '全部被解释器丢弃 ⇒ 该规则恒 0 命中、永远判通过',
  };
}

/**
 * threshold 指令的字段级检查 —— 补上「指令类型认出来了，但阈值本身不可用」这层。
 *
 * 两个真坑，都会让规则看起来在跑、实际恒通过（与 unresolved 同类，只是更隐蔽）：
 *
 * ① `threshold: "80"`（YAML 里加了引号）：`hasThresholds` 谓词**接受字符串**，
 *    但 `toThreshold` 只认 `typeof === 'number'` ⇒ 字符串被整条丢弃，
 *    解释成 threshold 类型却零指标。
 * ② `thresholds: { nestingDepth: "four" }`：`toThreshold` 里是 `Number(v)`，
 *    得 NaN；比较 `actual > NaN` 恒为 false ⇒ 该指标永远判达标。
 *
 * 定级：active 判 fatal（这条规则此刻就在产出假的通过），非 active 判 warn。
 */
function thresholdIssues(
  instr: ThresholdInstruction,
  raw: Record<string, unknown>,
  locator: string,
  isActive: boolean,
): SopRuleIssue[] {
  const level = isActive ? 'fatal' : 'warn';
  const scope = resolveInstructionScope(raw);
  const issues: SopRuleIssue[] = [];

  const singular = scope.threshold;
  if (typeof singular === 'string') {
    issues.push({
      file: locator,
      field: 'content.threshold',
      value: singular,
      level,
      reason:
        `threshold 写成了字符串（"${singular}"）：解释器只认 number，该值被整条丢弃 ⇒ ` +
        `规则没有任何可比指标。请去掉引号写成 threshold: ${singular}`,
    });
  }

  const declared = scope.thresholds;
  if (typeof declared === 'object' && declared !== null && !Array.isArray(declared)) {
    for (const [metric, value] of Object.entries(declared as Record<string, unknown>)) {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) continue;
      issues.push({
        file: locator,
        field: `content.thresholds.${metric}`,
        value,
        level,
        reason:
          `阈值 ${metric} 不是有限数字（Number(${JSON.stringify(value)}) = ${String(numeric)}）⇒ ` +
          '比较结果恒为 false，该指标永远判达标',
      });
    }
  }

  if (issues.length === 0 && Object.keys(instr.thresholds).length === 0) {
    issues.push({
      file: locator,
      field: 'content.thresholds',
      value: declared,
      level: 'warn',
      reason: '阈值指令未声明任何可比较指标，规则执行时会落 degraded（不产出检查结果）',
    });
  }

  return issues;
}

/**
 * 阈值指标「有没有人给它数」——决定这条规则转 active 后是产出结论还是固定降级。
 *
 * 三层判定：
 *   ① 登记为扫描后门禁（`POST_SCAN_GATE_BINDINGS` / 声明 executionStage: post-scan）
 *      ⇒ 合法。它由 gate 阶段判定，引擎不执行是设计。
 *   ①' 登记为映射型规则（`MAPPING_RULES`，如质量分映射）⇒ 合法。它定义换算关系、
 *      不设通过线，本来就不产生结论 —— 拿「没取数」判它是把语义读错了。
 *   ② 指标全在 `ENGINE_MEASURABLE_METRICS`（复杂度五项，由 pipeline 的 rule-metrics 取数）
 *      ⇒ 合法。
 *   ③ 其余 ⇒ **active 判 fatal**：没有任何取数实现，每次执行都落 skipped（degraded），
 *      既不产出结果又拖累 `ok`。这正是「云端下发了 4 条阈值规则、3 条永远拿不到数」的成因。
 *
 * 非 active 判 warn：草稿阶段还没接数据源属正常，拒收会误伤正在写的内容。
 */
function unmeasurableThresholdIssue(
  rule: SopRule,
  instr: ThresholdInstruction,
  locator: string,
): SopRuleIssue | null {
  if (readRuleSemantics(rule) !== 'engine') return null;
  const keys = Object.keys(instr.thresholds);
  if (keys.length === 0) return null; // 未声明指标已由 thresholdIssues 判 warn
  const unmeasurable = keys.filter((key) => !ENGINE_MEASURABLE_METRICS.includes(key));
  if (unmeasurable.length === 0) return null;
  return {
    file: locator,
    field: 'content.thresholds',
    value: unmeasurable,
    level: rule.status === 'active' ? 'fatal' : 'warn',
    reason:
      `阈值指标 ${unmeasurable.join(', ')} 没有任何取数实现：引擎内可取数的指标只有 ` +
      `${ENGINE_MEASURABLE_METRICS.join('/')}（packages/pipeline/src/rule-metrics.ts）。` +
      '转 active 后每次执行都拿不到实测值，只会落 skipped（含降级），既不产出结论又拖累整体 ok。' +
      '依赖整轮扫描聚合的指标（健康分/质量分/覆盖率）必须在 kernel/src/runner/post-scan-gate.ts ' +
      '的 POST_SCAN_GATE_BINDINGS 登记，或在规则里写 executionStage: post-scan',
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
