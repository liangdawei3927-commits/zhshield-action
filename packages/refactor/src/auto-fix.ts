import * as fs from 'fs';
import type { CodeSmell, TextEdit, Fix, FixResult } from './types';

type FixGenerator = (smell: CodeSmell, sourceDir: string) => Fix | null;

const FIELD_DECLARATION = /^(public\s+)?(?:static readonly|readonly static|static|readonly)?\s*(?:\w+)\s*:\s/;
const PUBLIC_PREFIX = /^public\s+/;
const THEN_CHAIN = /\.then\(/;
const METHOD_SIG = /^\s*(public|private|protected)?\s*(static\s+)?\w+\s*\(/;
const ASYNC_PREFIX = /^async\b/;
const FUNCTION_PREFIX = /^function\b/;
const EXTRACT_LITERAL = /将 "([^"]+)" 提取为共享常量文件/;
const NON_ALPHANUMERIC = /[^a-zA-Z0-9_]/g;
const LEADING_DIGIT = /^(\d)/;
const METHOD_NAME_PREFIX = /^[a-zA-Z_$]/;
const METHOD_DECLARATION = /^((?:public|private|protected)\s+)?(static\s+)?([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/;

// ─── Inappropriate-Intimacy: 将 public 字段改为 private ─────

const fixInappropriateIntimacy: FixGenerator = (smell, _sourceDir) => {
  const filePath = smell.location.filePath;
  const content = readFile(filePath);
  if (!content) return null;
  const lines = content.split('\n');
  if (smell.location.endLine > lines.length) return null;

  const edits: TextEdit[] = [];
  for (let i = smell.location.line; i <= Math.min(smell.location.endLine, lines.length); i++) {
    const line = lines[i - 1];
    const trimmed = line.trimStart();
    // Match field declarations without access modifier or with `public`
    // Pattern: [indent][public|static|readonly]* fieldName: Type;
    if (FIELD_DECLARATION.test(trimmed)) {
      const indent = line.length - line.trimStart().length;
      const replaced = ' '.repeat(indent) + 'private ' + trimmed.replace(PUBLIC_PREFIX, '');
      edits.push({
        filePath,
        startLine: i, startColumn: 1,
        endLine: i, endColumn: line.length + 1,
        replacement: replaced,
      });
    }
  }
  if (edits.length === 0) return null;
  return {
    smellId: smell.id,
    ruleId: smell.ruleId,
    description: `将 ${smell.location.filePath} 的 public 字段封装为 private`,
    edits,
  };
};

// ─── Callback-Hell: .then() 链 → async/await ────────────────

const fixCallbackHell: FixGenerator = (smell, _sourceDir) => {
  const filePath = smell.location.filePath;
  const content = readFile(filePath);
  if (!content) return null;
  const lines = content.split('\n');
  if (smell.location.endLine > lines.length) return null;

  const methodText = lines.slice(smell.location.line - 1, smell.location.endLine).join('\n');
  if (!THEN_CHAIN.test(methodText)) return null;

  const methodSigLine = findMethodSignatureLine(lines, smell.location.line - 1);
  const sigLine = lines[methodSigLine];
  if (ASYNC_PREFIX.test(sigLine.trimStart())) return null; // Already async

  const asyncSig = buildAsyncSignature(sigLine);
  if (!asyncSig) return null;

  const edits: TextEdit[] = [{
    filePath,
    startLine: methodSigLine + 1, startColumn: 1,
    endLine: methodSigLine + 1, endColumn: sigLine.length + 1,
    replacement: asyncSig,
  }];
  const thenEdit = buildThenToAwaitTodo(lines, filePath, smell.location.line, methodText);
  if (thenEdit) edits.push(thenEdit);

  return {
    smellId: smell.id,
    ruleId: smell.ruleId,
    description: `为 ${smell.context.className}.${smell.context.methodName}() 添加 async 关键字`,
    edits,
  };
};

/** 从指定行向上扫描方法签名所在行 */
function findMethodSignatureLine(lines: string[], startLine: number): number {
  let methodSigLine = startLine;
  for (let i = startLine; i >= 0; i--) {
    methodSigLine = i;
    const line = lines[i].trim();
    if (line.startsWith('async ') || METHOD_SIG.test(line)) break;
    if (line.includes('function') || line.includes('=>')) break;
  }
  return methodSigLine;
}

/** 在方法名或 function 关键字后插入 async，无法插入时返回 null */
function buildAsyncSignature(sigLine: string): string | null {
  const trimmedSig = sigLine.trimStart();
  const indent = sigLine.length - sigLine.trimStart().length;

  if (FUNCTION_PREFIX.test(trimmedSig)) {
    return ' '.repeat(indent) + 'async ' + trimmedSig;
  }
  if (METHOD_NAME_PREFIX.test(trimmedSig) && !trimmedSig.startsWith('constructor')) {
    const methodMatch = trimmedSig.match(METHOD_DECLARATION);
    if (!methodMatch) return null;
    const prefix = methodMatch[1] || '';
    const staticPrefix = methodMatch[2] || '';
    return ' '.repeat(indent) + prefix + staticPrefix + 'async ' + methodMatch[3] + trimmedSig.slice(methodMatch[0].length - 1);
  }
  return null;
}

/** 复杂 .then().catch() 链在首个 .then 处补充手动转换 TODO 注释 */
function buildThenToAwaitTodo(lines: string[], filePath: string, smellLine: number, methodText: string): TextEdit | null {
  if (!methodText.includes('.then(') || !methodText.includes('.catch(')) return null;

  const firstThenLine = smellLine + methodText.split('\n').findIndex(l => l.includes('.then('));
  if (firstThenLine < smellLine || firstThenLine > lines.length) return null;

  const thenLine = lines[firstThenLine - 1];
  const thenIndent = thenLine.length - thenLine.trimStart().length;
  return {
    filePath,
    startLine: firstThenLine, startColumn: 1,
    endLine: firstThenLine, endColumn: 1,
    replacement: ' '.repeat(thenIndent) + '// TODO: 将 .then() 链手动转换为 await (auto-fix 已添加 async 关键字)\n',
  };
}

// ─── Shotgun-Surgery: 提取硬编码字符串为常量 ─────────────────

const fixShotgunSurgery: FixGenerator = (smell, sourceDir) => {
  const filePath = smell.location.filePath;
  const content = readFile(filePath);
  if (!content) return null;

  const literal = extractLiteralFromSuggestion(smell);
  if (!literal) return null;

  const constantsFile = pathJoin(sourceDir, 'src', 'constants', 'shared-strings.ts');
  const varName = toConstantName(literal);
  const existingContent = loadConstantsContent(constantsFile);
  if (existingContent.includes(`export const ${varName} =`)) return null;

  const newEntry = `export const ${varName} = '${literal.replace(/'/g, "\\'")}';\n`;
  return {
    smellId: smell.id,
    ruleId: smell.ruleId,
    description: `将 "${literal}" 提取到 ${constantsFile}`,
    edits: [{
      filePath: constantsFile,
      startLine: 1, startColumn: 1,
      endLine: 1, endColumn: 1,
      replacement: existingContent + newEntry,
    }],
  };
};

function extractLiteralFromSuggestion(smell: CodeSmell): string | null {
  const match = smell.suggestion.description.match(EXTRACT_LITERAL);
  return match ? match[1] : null;
}

function toConstantName(literal: string): string {
  return literal
    .replace(NON_ALPHANUMERIC, '_')
    .replace(LEADING_DIGIT, '_$1')
    .toUpperCase();
}

function loadConstantsContent(constantsFile: string): string {
  try {
    return fs.readFileSync(constantsFile, 'utf-8');
  } catch {
    return '// 共享字符串常量 — auto-fix 生成\n\n';
  }
}

// ─── 注册表 ──────────────────────────────────────────────────

const FIX_GENERATORS: Record<string, FixGenerator> = {
  'inappropriate-intimacy': fixInappropriateIntimacy,
  'callback-hell': fixCallbackHell,
  'shotgun-surgery': fixShotgunSurgery,
};

export function isFixable(ruleId: string): boolean {
  return ruleId in FIX_GENERATORS;
}

export function generateFix(smell: CodeSmell, sourceDir: string): Fix | null {
  const gen = FIX_GENERATORS[smell.ruleId];
  if (!gen) return null;
  return gen(smell, sourceDir);
}

export function generateFixes(smells: CodeSmell[], sourceDir: string): Fix[] {
  const fixes: Fix[] = [];
  for (const smell of smells) {
    if (!smell.suggestion.autoFixable) continue;
    const fix = generateFix(smell, sourceDir);
    if (fix) fixes.push(fix);
  }
  return fixes;
}

export function applyFixes(fixes: Fix[]): FixResult {
  let fixed = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const [filePath, edits] of groupEditsByFile(fixes)) {
    const outcome = applyEditsToFile(filePath, edits);
    fixed += outcome.fixed;
    if (outcome.error) {
      failed++;
      errors.push(`${filePath}: ${outcome.error}`);
    }
  }

  return { fixed, failed, errors };
}

function groupEditsByFile(fixes: Fix[]): Map<string, TextEdit[]> {
  const fileEdits = new Map<string, TextEdit[]>();
  for (const fix of fixes) {
    for (const edit of fix.edits) {
      const list = fileEdits.get(edit.filePath) || [];
      list.push(edit);
      fileEdits.set(edit.filePath, list);
    }
  }
  return fileEdits;
}

function applyEditsToFile(filePath: string, edits: TextEdit[]): { fixed: number; error?: string } {
  edits.sort((a, b) => b.startLine - a.startLine || b.startColumn - a.startColumn);

  let fixed = 0;
  try {
    let content = fs.readFileSync(filePath, 'utf-8');
    for (const edit of edits) {
      const result = applyEdit(content, edit);
      if (!result) continue;
      content = result.content;
      if (result.wroteFile) {
        fs.writeFileSync(filePath, content, 'utf-8');
        fixed++;
      }
    }
    fs.writeFileSync(filePath, content, 'utf-8');
    fixed++;
    return { fixed };
  } catch (e: unknown) {
    return { fixed, error: e instanceof Error ? e.message : String(e) };
  }
}

function applyEdit(content: string, edit: TextEdit): { content: string; wroteFile: boolean } | null {
  const lines = content.split('\n');
  if (edit.startLine > lines.length) return null;

  // Handle single-line replacement
  if (edit.startLine === edit.endLine) {
    return { content: applySingleLineEdit(lines, edit), wroteFile: false };
  }

  // Multi-line: replace entire range
  return { content: applyMultiLineEdit(lines, edit), wroteFile: true };
}

/** 应用单行替换：仅替换行内 startColumn..endColumn 区间 */
function applySingleLineEdit(lines: string[], edit: TextEdit): string {
  const line = lines[edit.startLine - 1];
  const startIdx = edit.startColumn - 1;
  const endIdx = Math.min(edit.endColumn - 1, line.length);
  lines[edit.startLine - 1] = line.slice(0, startIdx) + edit.replacement + line.slice(endIdx);
  return lines.join('\n');
}

/** 应用多行替换：整段替换 startLine..endLine 范围 */
function applyMultiLineEdit(lines: string[], edit: TextEdit): string {
  const before = lines.slice(0, edit.startLine - 1);
  const after = lines.slice(edit.endLine);
  return before.join('\n') + '\n' + edit.replacement + '\n' + after.join('\n');
}

// ─── Helpers ──────────────────────────────────────────────────

function readFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function pathJoin(...parts: string[]): string {
  return parts.join('/').replace(/\/+/g, '/');
}
