const IDENT_CHAR_PAREN = /[a-zA-Z0-9_$)]/;
const IDENT_CHAR = /[a-zA-Z0-9_$]/;
const IDENT_FULL = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;

/** 提取方法文本中所有长度 ≥ 3 的链式调用片段（跳过字符串/模板字面量内部的 "."） */
export function extractMessageChains(methodText: string): string[] {
  const stringRanges = collectStringRanges(methodText);
  const isInsideString = (idx: number) =>
    stringRanges.some(([start, end]) => idx >= start && idx < end);

  const matches: string[] = [];
  let idx = 0;
  while (idx < methodText.length) {
    const dotIdx = methodText.indexOf('.', idx);
    if (dotIdx === -1) break;

    // i18n 键 tr('engine.xxx.yyy') 等字符串内容里的 "." 不是属性访问，跳过
    if (!isInsideString(dotIdx)) {
      const chain = extractChainAtDot(methodText, dotIdx);
      if (chain) matches.push(chain);
    }
    idx = dotIdx + 1;
  }
  return matches;
}

/** 收集字符串/模板字面量内容占据的字符区间，用于排除字面量内部的 "."。
 *  模板字面量的 ${...} 插值段是真实代码，其内部的 "." 仍是属性链，不纳入区间。 */
function collectStringRanges(methodText: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let i = 0;
  while (i < methodText.length) {
    const ch = methodText[i];
    if (ch === "'" || ch === '"') {
      i = scanQuotedString(methodText, i, ch, ranges);
    } else if (ch === '`') {
      i = scanTemplateString(methodText, i, ranges);
    } else {
      i++;
    }
  }
  return ranges;
}

/** 扫描单引号/双引号字符串，记录内容区间，返回结束后位置 */
function scanQuotedString(
  text: string,
  start: number,
  quote: string,
  ranges: Array<[number, number]>,
): number {
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2;
      continue;
    }
    if (text[i] === quote) {
      i++;
      break;
    }
    i++;
  }
  ranges.push([start, i]);
  return i;
}

/** 扫描模板字面量：字面段记入区间，${...} 插值段按真实代码跳过，返回结束后位置 */
function scanTemplateString(
  text: string,
  start: number,
  ranges: Array<[number, number]>,
): number {
  let i = start + 1;
  let literalFrom = i;
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2;
      continue;
    }
    if (text[i] === '`') {
      ranges.push([literalFrom, i]);
      return i + 1;
    }
    if (text[i] === '$' && text[i + 1] === '{') {
      ranges.push([literalFrom, i]);
      i = skipInterpolation(text, i + 2);
      literalFrom = i;
      continue;
    }
    i++;
  }
  ranges.push([literalFrom, Math.min(i, text.length)]);
  return i;
}

/** 跳过 ${...} 插值正文（括号配平），返回闭合 } 之后的位置 */
function skipInterpolation(text: string, start: number): number {
  let depth = 1;
  let i = start;
  while (i < text.length && depth > 0) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') depth--;
    i++;
  }
  return i;
}

function extractChainAtDot(methodText: string, dotIdx: number): string | null {
  const { before, after } = readChainTokens(methodText, dotIdx);
  if (!isValidChainBoundary(before, after)) return null;

  const { length: chainLen, endIdx: searchIdx } = measureChainLength(methodText, dotIdx);
  if (chainLen < 3) return null;

  const chainEnd = Math.min(searchIdx + 30, methodText.length);
  return methodText.slice(dotIdx - 10, chainEnd).trim();
}

/** 读取点号两侧的标识符 token */
function readChainTokens(methodText: string, dotIdx: number): { before: string; after: string } {
  let start = dotIdx - 1;
  while (start >= 0 && IDENT_CHAR_PAREN.test(methodText[start])) start--;
  const before = methodText.slice(start + 1, dotIdx);

  let end = dotIdx + 1;
  while (end < methodText.length && IDENT_CHAR.test(methodText[end])) end++;
  const after = methodText.slice(dotIdx + 1, end);

  return { before, after };
}

/** 校验点号两侧是否为合法链式边界（排除 this. 与括号 / 花括号后缀） */
function isValidChainBoundary(before: string, after: string): boolean {
  return Boolean(before) && Boolean(after) && before !== 'this' && ![')', '}'].includes(before);
}

function measureChainLength(
  methodText: string,
  dotIdx: number,
): { length: number; endIdx: number } {
  let chainLen = 0;
  let searchIdx = dotIdx;
  while (searchIdx < methodText.length) {
    const nextDot = methodText.indexOf('.', searchIdx + 1);
    if (nextDot === -1) break;
    const between = methodText.slice(searchIdx + 1, nextDot);
    if (!IDENT_FULL.test(between.trim())) break;
    chainLen++;
    searchIdx = nextDot;
  }
  return { length: chainLen, endIdx: searchIdx };
}