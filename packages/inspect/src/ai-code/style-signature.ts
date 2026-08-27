/**
 * 风格指纹分析（style-signature.ts）
 *
 * 附 E.5 style-signature 信号源：同文件风格突变 / 模板化命名 / AI 典型注释。
 * 输出可解释的 StyleSignal 列表（含内部权重 confidence），由调用方分级。
 * 本模块只做特征提取，不做"AI 判定"——避免伪科学（边界 1）。
 */

const COMMENT_LINE_RE = /^\s*(\/\/|\/\*|\*|#|--|<!--)/;
const NEWLINE_RE = /\r?\n/;
const INDENT_RE = /^[ \t]+/;

/** 风格指纹类型 */
export type StyleSignalKind = 'comment-marker' | 'mixed-indent' | 'templated-naming';

/** 单条风格信号：kind + 可解释 detail + 内部权重 */
export interface StyleSignal {
  kind: StyleSignalKind;
  confidence: number;
  detail: string;
}

/** AI 典型注释模式（大小写不敏感，仅用于注释行） */
const AI_COMMENT_PATTERNS: readonly RegExp[] = [
  /generated\s+by\s+(?:openai|chatgpt|gpt|copilot|claude|codeium|cursor|tabnine|bard|gemini)/i,
  /generated\s+(?:using|with)\s+(?:openai|chatgpt|gpt|copilot|claude|codeium|cursor|tabnine|bard|gemini)/i,
  /(?:written|authored|created)\s+by\s+(?:openai|chatgpt|gpt|copilot|claude|codeium|cursor|tabnine)/i,
  /\b(?:github\s+)?copilot\b/i,
  /\bgpt-\d+\b|\bchatgpt\b|\bclaude\b|\bcodeium\b|\btabnine\b/i,
];

/** 是否注释行（// /* * # -- <!--） */
function isCommentLine(line: string): boolean {
  return COMMENT_LINE_RE.test(line);
}

/** comment-marker：注释中出现 AI 工具典型标记 → 强风格信号 */
function commentMarkerSignal(content: string): StyleSignal | null {
  const lines = content.split(NEWLINE_RE);
  for (const line of lines) {
    if (!isCommentLine(line)) continue;
    for (const re of AI_COMMENT_PATTERNS) {
      const m = re.exec(line);
      if (m !== null) {
        const snippet = line.trim().slice(0, 80);
        return {
          kind: 'comment-marker',
          confidence: 0.9,
          detail: `AI tool marker in comment: "${snippet}"`,
        };
      }
    }
  }
  return null;
}

/** mixed-indent：≥2 种显著缩进宽度（各 ≥10 行）且少数派占比 ≥25% → 疑似拼接代码 */
function mixedIndentSignal(content: string): StyleSignal | null {
  const indentCounts = new Map<number, number>();
  let zeroIndentLines = 0;
  for (const line of content.split(NEWLINE_RE)) {
    if (line.trim() === '') continue;
    const m = INDENT_RE.exec(line);
    if (m === null) {
      zeroIndentLines += 1;
    } else {
      const width = m[0].length;
      indentCounts.set(width, (indentCounts.get(width) ?? 0) + 1);
    }
  }
  if (zeroIndentLines === 0) return null; // 没有顶层语句，不构成"拼接"上下文
  const significant = [...indentCounts.entries()]
    .filter(([, count]) => count >= 10)
    .map(([width]) => width)
    .sort((a, b) => a - b);
  if (significant.length < 2) return null;
  const total = significant.reduce((sum, width) => sum + (indentCounts.get(width) ?? 0), 0);
  if (total === 0) return null;
  const minority = Math.min(...significant.map((width) => indentCounts.get(width) ?? 0));
  if (minority / total < 0.25) return null;
  return {
    kind: 'mixed-indent',
    confidence: 0.4,
    detail: `mixed indentation widths (${significant.join(', ')} chars) suggest spliced code blocks`,
  };
}

/**
 * templated-naming：≥2 个"带序号基名"（如 item1/item2、step1/step2），
 * 模板化批量生成模式 → 弱风格信号。
 */
function templatedNamingSignal(content: string): StyleSignal | null {
  const trailingNumbers = new Map<string, Set<string>>();
  const re = /\b([a-zA-Z_$][a-zA-Z0-9_$]{1,}?)(\d+)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const base = m[1];
    const num = m[2];
    if (base === undefined || num === undefined) continue;
    if (base.length < 2) continue; // 跳过 x1 这类单字母基名
    let nums = trailingNumbers.get(base);
    if (nums === undefined) {
      nums = new Set();
      trailingNumbers.set(base, nums);
    }
    nums.add(num);
  }
  const numberedBases = [...trailingNumbers.entries()]
    .filter(([, nums]) => nums.size >= 2)
    .map(([base]) => base);
  if (numberedBases.length < 2) return null;
  return {
    kind: 'templated-naming',
    confidence: 0.5,
    detail: `templated identifiers with trailing numbers: ${numberedBases.slice(0, 3).join(', ')}`,
  };
}

/** 分析文件内容，提取全部风格信号（无命中返回空数组） */
export function analyzeStyleSignature(content: string): readonly StyleSignal[] {
  const signals: StyleSignal[] = [];
  const comment = commentMarkerSignal(content);
  if (comment !== null) signals.push(comment);
  const indent = mixedIndentSignal(content);
  if (indent !== null) signals.push(indent);
  const naming = templatedNamingSignal(content);
  if (naming !== null) signals.push(naming);
  return signals;
}
