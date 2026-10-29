import type { SopRule } from './sop-types';
import type { ContentInstruction } from './rule-evaluation';
import type {
  CheckListInstruction,
  PatternScanInstruction,
  ThresholdInstruction,
  ForbiddenPatternInstruction,
  ForbiddenRegexInstruction,
  RequiredContentInstruction,
  LayerBoundaryInstruction,
  ScannerDispatchInstruction,
  PresetInstruction,
  ToolDispatchInstruction,
  UnresolvedInstruction,
} from './rule-evaluation';
import {
  hasToolDispatch,
  hasLayers,
  hasChecks,
  hasForbidden,
  hasForbiddenRegex,
  hasRequired,
  hasScanners,
  hasPatterns,
  hasThresholds,
  hasPresets,
} from './content-predicates';

/**
 * ContentInterpreter — 将 SopRule.content 解释为可执行指令
 *
 * 每条 SOP 规则文件的 content 结构不同（patterns / checks / thresholds / forbidden / layers / scanners / presets），
 * 解释器根据存在哪些字段自动推断指令类型，供 SopRuleEngine 执行。
 * 字段存在性谓词见 ./content-predicates（纯函数抽取）。
 */
export class ContentInterpreter {
  /**
   * 解释单条规则的 content
   */
  interpret(rule: SopRule): ContentInstruction {
    const raw = rule.content ?? {};
    // 规则文件存在两种 schema：扁平（指令字段在顶层，如 test-fixtures）与嵌套
    // （指令字段写在 check 段，如 presets/sop-templates）。合并视图令两组谓词对
    // 两种写法都成立，同时保留 check 键供 tool-dispatch 读取 check.tool。
    const c = resolveInstructionScope(raw);
    if (hasToolDispatch(c)) return this.toToolDispatch(c);
    if (hasLayers(c)) return this.toLayerBoundary(c);
    if (hasChecks(c)) return this.toCheckList(c);
    if (hasForbidden(c)) return this.toForbidden(c);
    if (hasForbiddenRegex(c)) return this.toForbiddenRegex(c);
    if (hasRequired(c)) return this.toRequired(c);
    if (hasScanners(c)) return this.toScannerDispatch(c);
    if (hasPatterns(c)) return this.toPatternScan(c);
    if (hasThresholds(c)) return this.toThreshold(c);
    if (hasPresets(c)) return this.toPreset(c);
    return this.toUnresolved(raw);
  }

  /**
   * 兜底：content 无法解释为任何已知指令。
   *
   * 旧实现返回 `pattern-scan` + `JSON.stringify(content)`，把整份规则 JSON 当字面量
   * 去源码里搜 —— 必然 0 命中 → 评估结果恒为 passed，用户在面板上看到假的通过勾
   * （09-17 实证：module-boundary / type-consistency 两条 active 规则静默空跑）。
   * 现改为显式 unresolved，由 SopRuleEngine 降级为 degraded skipped：
   * 「什么都没查」不再等于「通过」。
   */
  private toUnresolved(c: Record<string, unknown>): UnresolvedInstruction {
    const keys = Object.keys(c);
    return { type: 'unresolved', reason: describeUnresolved(c, keys), keys };
  }

  private toToolDispatch(c: Record<string, unknown>): ToolDispatchInstruction {
    const check = (c.check ?? {}) as Record<string, unknown>;
    const conditions = (c.conditions ?? {}) as Record<string, unknown>;
    const judgment = (c.judgment ?? {}) as Record<string, unknown>;
    const fix = (c.fix ?? {}) as Record<string, unknown>;

    // 模板把内联检测规则声明在 check.semgrepRules（与 toolConfig 平级），适配器从
    // config.rules 读取：在此合并，使 registry 风格 config（如 typescript/lang/security/）
    // 无法本地解析时仍能以内联规则执行扫描。toolConfig 已含 rules 时保留既有声明。
    const toolConfig = { ...((check.toolConfig as Record<string, unknown>) ?? {}) };
    if (
      Array.isArray(check.semgrepRules) &&
      check.semgrepRules.length > 0 &&
      !Array.isArray(toolConfig.rules)
    ) {
      toolConfig.rules = check.semgrepRules;
    }
    // 适配器统一从 options.config?.config 读取注入配置；模板历史写法有
    // toolConfig.configFile（如 circular-dependency 的 .dependency-cruiser.cjs）与
    // toolConfig.configPath（如 gitleaks 的 ${ZHSHIELD_HOME}/gitleaks.toml），
    // 在此按别名收敛到同一读取点。config 已存在时保留既有值。
    const configAliases = ['configFile', 'configPath'] as const;
    for (const alias of configAliases) {
      if (toolConfig.config === undefined && toolConfig[alias] !== undefined) {
        toolConfig.config = toolConfig[alias];
        delete toolConfig[alias];
      }
    }
    // 顶层 thresholds（如 duplication 的 minLines/minTokens/minSimilarity）与 check.tool 平级声明，
    // 此前 tool-dispatch 分支只合并 check.toolConfig，顶层 thresholds 直接被丢弃 → 适配器
    // （如 jscpd）永远拿不到规则阈值，只能吃 CLI 默认值导致检出过严。并入 toolConfig 供
    // 适配器从 options.config.thresholds 读取；toolConfig 已显式声明 thresholds 时优先保留。
    if (toolConfig.thresholds === undefined && typeof c.thresholds === 'object' && c.thresholds !== null) {
      toolConfig.thresholds = c.thresholds;
    }

    return {
      type: 'tool-dispatch',
      tool: String(check.tool ?? ''),
      toolConfig,
      conditions: {
        languages: conditions.languages as string[] | undefined,
        filePatterns: conditions.filePatterns as string[] | undefined,
        excludePatterns: conditions.excludePatterns as string[] | undefined,
      },
      judgment: {
        passCondition: judgment.passCondition as string | undefined,
        blocking: judgment.blockOn as string | undefined,
        priority: judgment.priority as string | undefined,
        maxIssues: judgment.maxIssues as number | undefined,
      },
      fix: {
        autoFixAvailable: fix.autoFixAvailable as boolean | undefined,
        suggestionTemplate: fix.suggestionTemplate as string | undefined,
        resources: fix.resources as string[] | undefined,
      },
    };
  }

  private toCheckList(c: Record<string, unknown>): CheckListInstruction {
    const raw = Array.isArray(c.checks) ? (c.checks as unknown[]) : [];
    return {
      type: 'check-list',
      checks: raw.map((ch) => {
        // checks 条目两种写法兼容：字符串（`- helmet-configured`）或对象（`- rule: ...`）
        if (typeof ch === 'string') {
          return { rule: ch, level: 'error' };
        }
        const o = (ch ?? {}) as Record<string, unknown>;
        return {
          rule: String(o.rule ?? ''),
          level: String(o.level ?? 'error'),
        };
      }),
    };
  }

  private toPatternScan(c: Record<string, unknown>): PatternScanInstruction {
    return {
      type: 'pattern-scan',
      patterns: (c.patterns as string[]).map(String),
      fileExts: Array.isArray(c.fileExts) ? (c.fileExts as string[]).map(String) : undefined,
    };
  }

  private toThreshold(c: Record<string, unknown>): ThresholdInstruction {
    // 兼容单数 threshold 和复数 thresholds 两种写法
    const thresholds: Record<string, number> = {};
    if (typeof c.thresholds === 'object' && c.thresholds !== null) {
      for (const [k, v] of Object.entries(c.thresholds)) {
        thresholds[k] = Number(v);
      }
    } else if (typeof c.threshold === 'number') {
      thresholds.value = c.threshold;
    }
    return {
      type: 'threshold',
      thresholds,
      unit: typeof c.unit === 'string' ? c.unit : undefined,
      scope: typeof c.scope === 'string' ? c.scope : undefined,
    };
  }

  private toForbidden(c: Record<string, unknown>): ForbiddenPatternInstruction {
    return {
      type: 'forbidden',
      patterns: (c.forbidden as string[]).map(String),
      fileExts: Array.isArray(c.fileExts) ? (c.fileExts as string[]).map(String) : undefined,
      excludePatterns: Array.isArray(c.excludePatterns)
        ? (c.excludePatterns as string[]).map(String)
        : undefined,
    };
  }

  private toForbiddenRegex(c: Record<string, unknown>): ForbiddenRegexInstruction {
    const rawItems = (c.forbiddenRegex as Array<Record<string, unknown>>).filter(
      (it): it is Record<string, unknown> =>
        typeof it === 'object' && it !== null && typeof it.regex === 'string',
    );
    return {
      type: 'forbidden-regex',
      items: rawItems.map((it) => ({
        regex: String(it.regex),
        ...(typeof it.message === 'string' ? { message: it.message } : {}),
        ...(typeof it.suggestion === 'string' ? { suggestion: it.suggestion } : {}),
      })),
      fileExts: Array.isArray(c.fileExts) ? (c.fileExts as string[]).map(String) : undefined,
      excludePatterns: Array.isArray(c.excludePatterns)
        ? (c.excludePatterns as string[]).map(String)
        : undefined,
    };
  }

  private toRequired(c: Record<string, unknown>): RequiredContentInstruction {
    const rawItems = (c.required as Array<Record<string, unknown>>).filter(
      (it): it is Record<string, unknown> =>
        typeof it === 'object' && it !== null && typeof it.path === 'string',
    );
    return {
      type: 'required-content',
      items: rawItems.map((it) => ({
        path: String(it.path),
        ...(Array.isArray(it.fileExts) ? { fileExts: (it.fileExts as string[]).map(String) } : {}),
        ...(Array.isArray(it.excludePatterns)
          ? { excludePatterns: (it.excludePatterns as string[]).map(String) }
          : {}),
        ...(Array.isArray(it.contains) ? { contains: (it.contains as string[]).map(String) } : {}),
        ...(Array.isArray(it.containsAny)
          ? {
              containsAny: (it.containsAny as unknown[]).map((group) =>
                Array.isArray(group) ? group.map(String) : [String(group)],
              ),
            }
          : {}),
        ...(typeof it.json === 'object' && it.json !== null
          ? { json: it.json as Record<string, unknown> }
          : {}),
        ...(Array.isArray(it.jsdocOn) ? { jsdocOn: (it.jsdocOn as string[]).map(String) } : {}),
      })),
    };
  }

  private toLayerBoundary(c: Record<string, unknown>): LayerBoundaryInstruction {
    return {
      type: 'layer-boundary',
      layers: (c.layers as Array<{ name: string; allowedDependencies: string[] }>).map((l) => ({
        name: String(l.name ?? ''),
        allowedDependencies: Array.isArray(l.allowedDependencies)
          ? l.allowedDependencies.map(String)
          : [],
      })),
      excludePatterns: Array.isArray(c.excludePatterns)
        ? (c.excludePatterns as string[]).map(String)
        : undefined,
    };
  }

  private toScannerDispatch(c: Record<string, unknown>): ScannerDispatchInstruction {
    return {
      type: 'scanner-dispatch',
      scanners: (c.scanners as string[]).map(String),
      schedule: typeof c.schedule === 'string' ? c.schedule : undefined,
    };
  }

  private toPreset(c: Record<string, unknown>): PresetInstruction {
    return {
      type: 'preset',
      presets: (c.presets as string[]).map(String),
    };
  }
}

// Re-export types for convenience
export type {
  ContentInstruction,
  PatternScanInstruction,
  CheckListInstruction,
  ThresholdInstruction,
  ForbiddenPatternInstruction,
  LayerBoundaryInstruction,
  ScannerDispatchInstruction,
  PresetInstruction,
  ToolDispatchInstruction,
  UnresolvedInstruction,
} from './rule-evaluation';

/**
 * 构造指令作用域视图：把嵌套 schema 的 check 段字段提升到顶层。
 *
 * SopRuleParser 把整份 YAML 文档作为 content 传入（content = parsed），而内联指令
 * 谓词读的是 content 顶层字段。嵌套 schema 的规则文件（presets/sop-templates）把
 * 指令写在 check 段下（check.forbiddenRegex 等），不提升就会一律落 unresolved。
 *
 * 顶层字段优先（扁平 schema 或显式覆盖），check 段作为补充；check 键本身保留，
 * 供 hasToolDispatch 读取 check.tool。
 */
export function resolveInstructionScope(raw: Record<string, unknown>): Record<string, unknown> {
  const check = raw.check;
  if (typeof check !== 'object' || check === null || Array.isArray(check)) return raw;
  return { ...(check as Record<string, unknown>), ...raw };
}

/**
 * 生成 unresolved 的可读原因（纯函数，供 ContentInterpreter 兜底使用）。
 *
 * 优先识别高频写法错误（check.rules 声明了内联检查项却缺 check.tool），
 * 使规则作者一眼看出问题所在，而非面对一句笼统的「无法识别」。
 */
function describeUnresolved(c: Record<string, unknown>, keys: string[]): string {
  const check = c.check as Record<string, unknown> | undefined;
  const hasCheckObj = typeof check === 'object' && check !== null && !Array.isArray(check);
  if (hasCheckObj && Array.isArray(check.rules) && check.rules.length > 0) {
    return (
      `check.rules 已声明 ${check.rules.length} 项内联检查，但缺少 check.tool，` +
      `无法确定由哪个工具执行；请补 check.tool，或改用内核可解释的写法 ` +
      `(patterns / forbidden / forbiddenRegex / required / layers / checks)`
    );
  }
  if (keys.length === 0) {
    return '规则 content 为空，无可执行指令';
  }
  return `无法识别的规则内容写法（顶层键: ${keys.join(', ')}）`;
}
