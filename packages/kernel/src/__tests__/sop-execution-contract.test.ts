import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as yaml from 'js-yaml';

/**
 * SOP 规则 `execution` 段「执行契约」守卫（2026-10-25 建立）
 *
 * 背景（实测）：44 条内置规则中 43 条声明了 `execution.timeout`，另有
 * `maxConcurrency` / `retryCount` / `scope` / `schedule`。但
 * `sop-loader-parser.ts` 只在解析边界读 `execution.mode`，其余字段**当场丢弃**，
 * 从不进入 SopRule —— 典型「声明了却没执行」，且比"无人消费"更靠前：
 * 连类型边界都过不去，任何下游都无从消费。
 *
 * 为什么选择删除而不是接上消费方：
 *   1. 取值不可信。实测 semgrep 冷启动 80–150s、整轮体检 123s，而 semgrep 类规则
 *      声明 `timeout: 60`；另有 `timeout: 1` / `timeout: 5` 这类物理上不可能的预算。
 *      若接上消费方，规则出厂即超时 —— 恰是 2026-10-24 刚修掉的同类故障。
 *   2. 引擎已有唯一权威超时契约：`DEFAULT_TOOL_SCAN_TIMEOUT_MS`（300s，见
 *      inspect/adapters/tool-runner.ts）+ kernel 外层硬上限 + `scan(options.timeout)`。
 *      再加第三只旋钮只会制造"到底哪个生效"的歧义。
 *   3. 规则 YAML 是①大脑与②引擎之间的唯一接口。接口里声明引擎不读的字段，
 *      就是撒谎的接口 —— 留着比删掉更坏（会被当成"已实现的开关"）。
 *
 * 本守卫的作用：把「先实现、再声明」变成机器可查的纪律。以后想给规则加执行参数，
 * 必须先让解析器读它、让引擎用它，再来改这里。
 */

const PRESETS_DIR = path.resolve(__dirname, '../sop/presets/sop-templates');

/**
 * `execution` 段允许出现的键 —— 仅限引擎真正读取的。
 * 判断标准不是"有没有出现在类型里"，而是"sop-loader-parser 有没有把它送进 SopRule"。
 */
const ALLOWED_EXECUTION_KEYS = new Set(['mode']);

/** 合法执行模式 —— 必须与 sop-types.ts 的 `ExecutionMode` 联合类型逐一对应 */
const EXECUTION_MODE_VALUES = new Set(['sync', 'async', 'periodic', 'event']);

interface RuleFile {
  readonly relPath: string;
  readonly raw: Record<string, unknown>;
}

/** 递归收集规则 YAML（跳过 _registry.yml 等非规则资产） */
function collectRuleFiles(dir: string, base = dir): RuleFile[] {
  const out: RuleFile[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectRuleFiles(full, base));
      continue;
    }
    if (!entry.name.endsWith('.yml') && !entry.name.endsWith('.yaml')) continue;
    if (entry.name.startsWith('_')) continue; // _registry.yml / _meta.yml
    const relPath = path.relative(base, full);
    const parsed = yaml.load(fs.readFileSync(full, 'utf8'));
    if (!parsed || typeof parsed !== 'object') continue;
    out.push({ relPath, raw: parsed as Record<string, unknown> });
  }
  return out;
}

const ruleFiles = collectRuleFiles(PRESETS_DIR);
const withExecution = ruleFiles.filter(
  (r) => r.raw.execution && typeof r.raw.execution === 'object',
);

describe('SOP execution 段执行契约', () => {
  it('样本自证：presets 规则文件与执行段必须真的被读到（不是空集假绿）', () => {
    expect(ruleFiles.length).toBeGreaterThanOrEqual(40);
    expect(withExecution.length).toBeGreaterThanOrEqual(40);
    // 打印真阳性计数：绿的时候也要能看见查了多少条，而不是只看 PASS
    console.log(
      `[sop-execution-contract] 规则文件 ${ruleFiles.length} 条，含 execution 段 ${withExecution.length} 条`,
    );
  });

  it('execution 段不得出现未被解析器消费的字段', () => {
    const violations: string[] = [];
    for (const rule of withExecution) {
      const exec = rule.raw.execution as Record<string, unknown>;
      for (const key of Object.keys(exec)) {
        if (ALLOWED_EXECUTION_KEYS.has(key)) continue;
        violations.push(`${rule.relPath}: execution.${key} = ${JSON.stringify(exec[key])}`);
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `发现声明了却没执行的执行参数（${violations.length} 处）。\n` +
          `这些字段在 sop-loader-parser 里被直接丢弃，永远不会生效。\n` +
          `处置：删除该字段；若确实需要，先让解析器读它、让引擎用它，再把键加进 ALLOWED_EXECUTION_KEYS。\n` +
          violations.map((v) => `  - ${v}`).join('\n'),
      );
    }
    expect(violations).toEqual([]);
  });

  it('execution.mode 取值合法（唯一被消费的字段必须自洽）', () => {
    const bad = withExecution
      .map((r) => ({
        relPath: r.relPath,
        mode: (r.raw.execution as Record<string, unknown>).mode,
      }))
      .filter((x) => typeof x.mode !== 'string' || !EXECUTION_MODE_VALUES.has(x.mode));
    expect(bad.map((b) => `${b.relPath}: mode=${JSON.stringify(b.mode)}`)).toEqual([]);
  });
});
