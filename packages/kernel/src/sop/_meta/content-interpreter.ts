import type { SopRule } from './sop-types';
import type { ContentInstruction } from './rule-evaluation';
import type {
  CheckListInstruction,
  PatternScanInstruction,
  ThresholdInstruction,
  ForbiddenPatternInstruction,
  LayerBoundaryInstruction,
  ScannerDispatchInstruction,
  PresetInstruction,
  ToolDispatchInstruction,
} from './rule-evaluation';

/**
 * ContentInterpreter — 将 SopRule.content 解释为可执行指令
 *
 * 每条 SOP 规则文件的 content 结构不同（patterns / checks / thresholds / forbidden / layers / scanners / presets），
 * 解释器根据存在哪些字段自动推断指令类型，供 SopRuleEngine 执行。
 */
export class ContentInterpreter {
  /**
   * 解释单条规则的 content
   */
  interpret(rule: SopRule): ContentInstruction {
    const c = rule.content ?? {};
    if (this.hasToolDispatch(c)) return this.toToolDispatch(c);
    if (this.hasLayers(c)) return this.toLayerBoundary(c);
    if (this.hasChecks(c)) return this.toCheckList(c);
    if (this.hasForbidden(c)) return this.toForbidden(c);
    if (this.hasScanners(c)) return this.toScannerDispatch(c);
    if (this.hasPatterns(c)) return this.toPatternScan(c);
    if (this.hasThresholds(c)) return this.toThreshold(c);
    if (this.hasPresets(c)) return this.toPreset(c);
    return { type: 'pattern-scan', patterns: [JSON.stringify(c)] };
  }

  private hasToolDispatch(c: Record<string, unknown>): boolean {
    const check = c.check;
    return typeof check === 'object' && check !== null && typeof (check as Record<string, unknown>).tool === 'string';
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

  private hasChecks(c: Record<string, unknown>): boolean {
    return Array.isArray(c.checks) && c.checks.length > 0;
  }

  private hasPatterns(c: Record<string, unknown>): boolean {
    return Array.isArray(c.patterns) && c.patterns.length > 0;
  }

  private hasThresholds(c: Record<string, unknown>): boolean {
    return (
      (typeof c.threshold === 'number' || typeof c.threshold === 'string') ||
      (typeof c.thresholds === 'object' && c.thresholds !== null)
    );
  }

  private hasForbidden(c: Record<string, unknown>): boolean {
    return Array.isArray(c.forbidden) && c.forbidden.length > 0;
  }

  private hasLayers(c: Record<string, unknown>): boolean {
    return Array.isArray(c.layers) && c.layers.length > 0;
  }

  private hasScanners(c: Record<string, unknown>): boolean {
    return Array.isArray(c.scanners) && c.scanners.length > 0;
  }

  private hasPresets(c: Record<string, unknown>): boolean {
    return Array.isArray(c.presets) && c.presets.length > 0;
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
