// F4 合成对抗测试 — synthetic attack-pattern → fixture generator (PURE: string in,
// data out; no fs/network/LLM/clock — disk IO lives in tests only).
// YAML schema (one doc per file, instances in __tests__/attack-patterns/):
//   patternId, description, baseTemplate (may contain {ZW}), expectedHit:boolean,
//   expectedFinding?, semgrepRuleId?, fileExt?, defaultFileName? (isEnvFile only),
//   category: prompt-injection|supply-chain|secret-exfiltration|ui-redress,
//   targetDetector: scanCommentInstructions|classifyPackageJsonScripts|
//                   scanMarkdownHiddenLinks|isEnvFile   (injection-guard exports),
//   localDiversifiers?/globalDiversifiers?: Diversifier[] (content/context mutations)
// Diversifier union:
//   {type:commentStyle, style:line-slash|line-hash|block|html}
//   {type:casing, mode:upper|lower} | {type:whitespace, mode:double-spaces}
//   {type:textReplace, find, replaceWith} | {type:zeroWidth, codepoint:"200B"}
//   {type:fileName, name}
//   {type:contextPrefix|contextSuffix, preset:benign-code-header|
//     benign-code-footer|benign-doc-lines|benign-extra-script}
import { load as loadYaml } from 'js-yaml';

const HEX4_RE = /^[0-9A-Fa-f]{4}$/;

export type AttackCategory = 'prompt-injection' | 'supply-chain' | 'secret-exfiltration' | 'ui-redress';

export type TargetDetector =
  | 'scanCommentInstructions'
  | 'classifyPackageJsonScripts'
  | 'scanMarkdownHiddenLinks'
  | 'isEnvFile';

export type CommentStyle = 'line-slash' | 'line-hash' | 'block' | 'html';
export type ContextPreset = 'benign-code-header' | 'benign-code-footer' | 'benign-doc-lines' | 'benign-extra-script';

export type Diversifier =
  | { type: 'commentStyle'; style: CommentStyle }
  | { type: 'casing'; mode: 'upper' | 'lower' }
  | { type: 'whitespace'; mode: 'double-spaces' }
  | { type: 'textReplace'; find: string; replaceWith: string }
  | { type: 'zeroWidth'; codepoint: string }
  | { type: 'fileName'; name: string }
  | { type: 'contextPrefix'; preset: ContextPreset }
  | { type: 'contextSuffix'; preset: ContextPreset };

export interface AttackPattern {
  readonly patternId: string;
  readonly description: string;
  readonly category: AttackCategory;
  readonly semgrepRuleId?: string;
  readonly targetDetector: TargetDetector;
  readonly fileExt: string;
  readonly defaultFileName?: string;
  readonly expectedHit: boolean;
  readonly expectedFinding?: string;
  readonly baseTemplate: string;
  readonly localDiversifiers: readonly Diversifier[];
  readonly globalDiversifiers: readonly Diversifier[];
}

export interface GeneratedVariant {
  readonly patternId: string;
  readonly variantIndex: number;
  readonly variantLabel: string;
  readonly fileName: string;
  readonly fileExt: string;
  readonly content: string;
  readonly expectHit: boolean;
  readonly targetDetector: TargetDetector;
  readonly expectedFinding?: string;
  readonly planDescription: string;
}

const CATEGORIES: readonly AttackCategory[] = ['prompt-injection', 'supply-chain', 'secret-exfiltration', 'ui-redress'];
const DETECTORS: readonly TargetDetector[] = ['scanCommentInstructions', 'classifyPackageJsonScripts', 'scanMarkdownHiddenLinks', 'isEnvFile'];
const COMMENT_STYLES: readonly CommentStyle[] = ['line-slash', 'line-hash', 'block', 'html'];
const CONTEXT_PRESETS: readonly ContextPreset[] = ['benign-code-header', 'benign-doc-lines', 'benign-extra-script', 'benign-code-footer'];
 
const ZERO_WIDTH_FAMILY = new RegExp('\\u200B|\\u200C|\\u200D|\\u2060|\\uFEFF', 'g');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function fail(source: string, message: string): never {
  throw new Error(`attack-pattern[${source}]: ${message}`);
}

function requireString(record: Record<string, unknown>, field: string, source: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.trim().length === 0) return fail(source, `field '${field}' must be a non-empty string`);
  return value;
}

function requireEnum<T extends string>(value: unknown, allowed: readonly T[], field: string, source: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    return fail(source, `field '${field}' must be one of ${allowed.join(' | ')}, got ${String(value)}`);
  }
  return value as T;
}

function optionalString(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === 'string' ? value : undefined;
}
function parseDiversifiers(value: unknown, source: string): Diversifier[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return fail(source, 'diversifiers must be a list');
  return value.map((entry): Diversifier => parseDiversifier(entry, source));
}

function parseDiversifier(raw: unknown, source: string): Diversifier {
  if (!isRecord(raw)) return fail(source, 'each diversifier must be a mapping');
  const types = ['commentStyle', 'casing', 'whitespace', 'textReplace', 'zeroWidth', 'fileName', 'contextPrefix', 'contextSuffix'] as const;
  const type = requireEnum(raw.type, types, 'diversifier.type', source);
  switch (type) {
    case 'commentStyle':
      return { type, style: requireEnum(raw.style, COMMENT_STYLES, 'style', source) };
    case 'casing':
      return { type, mode: requireEnum(raw.mode, ['upper', 'lower'], 'mode', source) };
    case 'whitespace':
      return { type, mode: requireEnum(raw.mode, ['double-spaces'], 'mode', source) };
    case 'textReplace':
      return { type, find: requireString(raw, 'find', source), replaceWith: requireString(raw, 'replaceWith', source) };
    case 'zeroWidth': {
      const codepoint = requireString(raw, 'codepoint', source);
      if (!HEX4_RE.test(codepoint)) return fail(source, `zeroWidth.codepoint must be 4 hex digits, got '${codepoint}'`);
      return { type, codepoint };
    }
    case 'fileName':
      return { type, name: requireString(raw, 'name', source) };
    case 'contextPrefix':
    case 'contextSuffix':
      return { type, preset: requireEnum(raw.preset, CONTEXT_PRESETS, 'preset', source) };
  }
}

export function parseAttackPattern(rawYaml: string, source = 'inline'): AttackPattern {
  const doc: unknown = loadYaml(rawYaml);
  if (!isRecord(doc)) return fail(source, 'document must be a YAML mapping');
  const pattern: AttackPattern = {
    patternId: requireString(doc, 'patternId', source),
    description: requireString(doc, 'description', source),
    category: requireEnum(doc.category, CATEGORIES, 'category', source),
    semgrepRuleId: optionalString(doc, 'semgrepRuleId'),
    targetDetector: requireEnum(doc.targetDetector, DETECTORS, 'targetDetector', source),
    fileExt: optionalString(doc, 'fileExt') ?? '',
    defaultFileName: optionalString(doc, 'defaultFileName'),
    expectedHit: doc.expectedHit === true,
    expectedFinding: optionalString(doc, 'expectedFinding'),
    baseTemplate: requireString(doc, 'baseTemplate', source),
    localDiversifiers: parseDiversifiers(doc.localDiversifiers, source),
    globalDiversifiers: parseDiversifiers(doc.globalDiversifiers, source),
  };
  if (doc.expectedHit !== true && doc.expectedHit !== false) return fail(source, "field 'expectedHit' must be a boolean");
  for (const d of [...pattern.localDiversifiers, ...pattern.globalDiversifiers]) {
    const preset = d.type === 'contextPrefix' || d.type === 'contextSuffix' ? d.preset : undefined;
    const jsonDetector = pattern.targetDetector === 'classifyPackageJsonScripts';
    if (preset === 'benign-extra-script' && !jsonDetector) {
      return fail(source, `preset 'benign-extra-script' only applies to classifyPackageJsonScripts (${pattern.patternId})`);
    }
    if (preset !== undefined && preset !== 'benign-extra-script' && jsonDetector) {
      return fail(source, `preset '${preset}' cannot apply to classifyPackageJsonScripts (${pattern.patternId})`);
    }
  }
  return pattern;
}

export function loadAttackPatternsFromSources(sources: readonly string[]): AttackPattern[] {
  return sources.map((source, i) => parseAttackPattern(source, `pattern-${i}`));
}

const CONTEXT_TEXT: Record<ContextPreset, string> = {
  'benign-code-header': '// generated benign context: module bootstrap\nexport const MAX_RETRIES = 3;\n',
  'benign-code-footer': '\nexport function reportHealth(): boolean {\n  return true;\n}\n',
  'benign-doc-lines': '# Notes\n\nRoutine release documentation line.\n',
  'benign-extra-script': '',
};

const DEFAULT_STYLE_BY_EXT: ReadonlyMap<string, CommentStyle> = new Map([
  ['.py', 'line-hash'], ['.md', 'html'],
]);

function wrapComment(payload: string, style: CommentStyle): { text: string; ext: string } {
  switch (style) {
    case 'line-slash': return { text: `// ${payload}\n`, ext: '.ts' };
    case 'line-hash': return { text: `# ${payload}\n`, ext: '.py' };
    case 'block': return { text: `/* ${payload} */\n`, ext: '.ts' };
    case 'html': return { text: `<!-- ${payload} -->\n`, ext: '.md' };
  }
}

function renderPackageJson(command: string, withBenignSiblings: boolean): string {
  const scripts: Record<string, string> = { postinstall: command };
  if (withBenignSiblings) {
    scripts.build = 'tsc -p tsconfig.json';
    scripts.test = 'vitest run';
  }
  const body = { name: 'generated-pkg', version: '1.0.0', private: true, scripts };
  return `${JSON.stringify(body, null, 2)}\n`;
}

interface RenderState {
  payload: string;
  ext: string;
  fileNameOverride?: string;
  extraScriptContext: boolean;
  contexts: Array<{ position: 'prefix' | 'suffix'; preset: ContextPreset }>;
  commentStyle?: CommentStyle;
}

function applyDiversifier(state: RenderState, d: Diversifier): void {
  switch (d.type) {
    case 'textReplace': state.payload = state.payload.split(d.find).join(d.replaceWith); return;
    case 'zeroWidth': {
      const ch = String.fromCharCode(Number.parseInt(d.codepoint, 16));
      state.payload = state.payload.replace(ZERO_WIDTH_FAMILY, ch).split('{ZW}').join(ch);
      return;
    }
    case 'casing': state.payload = d.mode === 'upper' ? state.payload.toUpperCase() : state.payload.toLowerCase(); return;
    case 'whitespace': state.payload = state.payload.split(' ').join('  '); return;
    case 'commentStyle': state.commentStyle = d.style; return;
    case 'fileName': state.fileNameOverride = d.name; return;
    case 'contextPrefix':
    case 'contextSuffix':
      state.contexts.push({ position: d.type === 'contextPrefix' ? 'prefix' : 'suffix', preset: d.preset });
      return;
  }
}

function renderContent(pattern: AttackPattern, plan: readonly Diversifier[]): { content: string; ext: string; fileName: string } {
  const state: RenderState = { payload: pattern.baseTemplate, ext: pattern.fileExt, extraScriptContext: false, contexts: [] };
  for (const d of plan) applyDiversifier(state, d);

  let content: string;
  let ext = state.ext;
  if (pattern.targetDetector === 'classifyPackageJsonScripts') {
    content = renderPackageJson(state.payload, state.extraScriptContext || state.contexts.length > 0);
  } else if (pattern.targetDetector === 'scanCommentInstructions') {
    const style = state.commentStyle ?? DEFAULT_STYLE_BY_EXT.get(ext) ?? 'line-slash';
    const wrapped = wrapComment(state.payload, style);
    content = wrapped.text;
    ext = wrapped.ext;
  } else {
    content = `${state.payload}\n`;
  }

  for (const ctx of state.contexts) {
    if (ctx.preset === 'benign-extra-script') continue;
    const text = CONTEXT_TEXT[ctx.preset];
    content = ctx.position === 'prefix' ? `${text}${content}` : `${content}${text}`;
  }

  let fileName: string;
  if (pattern.targetDetector === 'classifyPackageJsonScripts') {
    fileName = 'package.json';
  } else if (pattern.targetDetector === 'isEnvFile') {
    fileName = state.fileNameOverride ?? pattern.defaultFileName ?? '.env';
  } else {
    fileName = `snippet${ext}`;
  }
  return { content, ext, fileName };
}

function enumeratePlans(pattern: AttackPattern): Diversifier[][] {
  const plans: Diversifier[][] = [[]];
  for (const local of pattern.localDiversifiers) plans.push([local]);
  for (const global of pattern.globalDiversifiers) plans.push([global]);
  const [firstLocal] = pattern.localDiversifiers;
  const [firstGlobal] = pattern.globalDiversifiers;
  if (firstLocal !== undefined && firstGlobal !== undefined) plans.push([firstLocal, firstGlobal]);
  return plans;
}

export function generateVariants(patterns: readonly AttackPattern[]): GeneratedVariant[] {
  const out: GeneratedVariant[] = [];
  for (const pattern of patterns) {
    enumeratePlans(pattern).forEach((plan, variantIndex) => {
      const planDescription = plan.length === 0 ? 'baseline' : plan.map((d) => d.type).join('+');
      const { content, ext, fileName } = renderContent(pattern, plan);
      const label = `generated/${pattern.patternId}/variant-${String(variantIndex).padStart(2, '0')}-${planDescription}/${fileName}`;
      out.push({
        patternId: pattern.patternId,
        variantIndex,
        variantLabel: label,
        fileName,
        fileExt: ext,
        content,
        expectHit: pattern.expectedHit,
        targetDetector: pattern.targetDetector,
        expectedFinding: pattern.expectedFinding,
        planDescription,
      });
    });
  }
  return out;
}
