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
    const c = rule.content ?? {};
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
    return { type: 'pattern-scan', patterns: [JSON.stringify(c)] };
  }

  private toToolDispatch(c: Record<string, unknown>): ToolDispatchInstruction {
    const check = (c.check ?? {}) as Record<string, unknown>;
    const conditions = (c.conditions ?? {}) as Record<string, unknown>;
    const judgment = (c.judgment ?? {}) as Record<string, unknown>;
    const fix = (c.fix ?? {}) as Record<string, unknown>;

    return {
      type: 'tool-dispatch',
      tool: String(check.tool ?? ''),
      toolConfig: (check.toolConfig as Record<string, unknown>) ?? {},
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
    return {
      type: 'check-list',
      checks: (c.checks as Array<{ rule: string; level: string }>).map((ch) => ({
        rule: String(ch.rule ?? ''),
        level: String(ch.level ?? 'error'),
      })),
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
} from './rule-evaluation';
