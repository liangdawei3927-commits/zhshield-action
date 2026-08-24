import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MalwareItem, MalwareType } from './types';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-electron', 'build', 'coverage', '.turbo', '.next', '.cache', 'release']);
const MAX_DEPTH = 12;
const PACKAGE_JSON = 'package.json';
const MARKDOWN_EXT = '.md';
const ENV_FILE_NAMES = new Set(['.env', '.env.local', '.env.development', '.env.production', '.env.test']);

const LINE_COMMENT_PREFIX = new Map<string, string>([
  ['.ts', '//'], ['.tsx', '//'], ['.js', '//'], ['.jsx', '//'],
  ['.mjs', '//'], ['.cjs', '//'], ['.py', '#'],
]);

const BLOCK_COMMENT_DELIMS = new Map<string, readonly [string, string]>([
  ['.ts', ['/*', '*/']], ['.tsx', ['/*', '*/']], ['.js', ['/*', '*/']],
  ['.jsx', ['/*', '*/']], ['.mjs', ['/*', '*/']], ['.cjs', ['/*', '*/']],
  ['.md', ['<!--', '-->']],
]);

const INSTRUCTION_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['ignore-previous-instructions', /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions?/i],
  ['disregard-rules', /disregard\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions?|rules)/i],
  ['system-prompt-reference', /system\s+prompt/i],
  ['identity-takeover', /you\s+are\s+now\s+(?:a|an|the)\s+\w+/i],
];

const SCRIPT_SUSPICIOUS_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['remote-content-piped-to-shell', /(?:curl|wget)\b[^|]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/],
  ['base64-decode-execution', /\bbase64\s+(?:-d|-D|--decode)\b/],
  ['eval-usage', /\beval\b/],
  ['force-delete', /\brm\s+-rf\b/],
];

const HIDDEN_STYLE_PATTERN = /display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?:px)?\s*[;'"}]/i;
const ANCHOR_TAG_PATTERN = /<a\b[^>]*>/gi;
const MD_LINK_TARGET_PATTERN = /\[[^\]]*\]\(([^)]*)\)/g;
const ZERO_WIDTH_PATTERN = /(?:\u200B|\u200C|\u200D|\u2060|\uFEFF)/;

export interface ScriptVerdict {
  script: string;
  command: string;
  verdict: 'safe' | 'suspicious';
  matchedPattern?: string;
}

interface CommentLine {
  line: number;
  text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toFinding(params: {
  type: MalwareType;
  severity: MalwareItem['severity'];
  title: string;
  description: string;
  file: string;
  line: number;
  pattern: string;
  evidence: string;
}): MalwareItem {
  return { id: randomUUID(), ...params };
}
export function extractComments(content: string, ext: string): CommentLine[] {
  const linePrefix = LINE_COMMENT_PREFIX.get(ext);
  const delims = BLOCK_COMMENT_DELIMS.get(ext);
  const out: CommentLine[] = [];
  let inBlock = false;

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    if (inBlock) {
      const closeIdx = delims ? raw.indexOf(delims[1]) : -1;
      if (closeIdx >= 0) {
        inBlock = false;
        out.push({ line: i + 1, text: raw.slice(0, closeIdx) });
      } else {
        out.push({ line: i + 1, text: raw });
      }
      continue;
    }
    const trimmed = raw.trimStart();
    if (linePrefix && trimmed.startsWith(linePrefix)) {
      out.push({ line: i + 1, text: trimmed.slice(linePrefix.length) });
      continue;
    }
    if (delims && trimmed.startsWith(delims[0])) {
      const closeIdx = raw.indexOf(delims[1], delims[0].length);
      if (closeIdx >= 0) {
        out.push({ line: i + 1, text: raw.slice(delims[0].length, closeIdx) });
      } else {
        inBlock = true;
        out.push({ line: i + 1, text: raw.slice(delims[0].length) });
      }
    }
  }
  return out;
}

export function scanCommentInstructions(
  content: string,
  ext: string,
): Array<{ line: number; matchedPattern: string; evidence: string }> {
  const hits: Array<{ line: number; matchedPattern: string; evidence: string }> = [];
  for (const { line, text } of extractComments(content, ext)) {
    for (const [name, pattern] of INSTRUCTION_PATTERNS) {
      if (!pattern.test(text)) continue;
      hits.push({ line, matchedPattern: name, evidence: text.trim().slice(0, 160) });
      break;
    }
  }
  return hits;
}

export function classifyPackageJsonScripts(raw: string): ScriptVerdict[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isRecord(parsed) || !isRecord(parsed.scripts)) return [];

  return Object.entries(parsed.scripts)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([script, command]) => {
      const matched = SCRIPT_SUSPICIOUS_PATTERNS.find(([, pattern]) => pattern.test(command));
      return matched
        ? { script, command, verdict: 'suspicious' as const, matchedPattern: matched[0] }
        : { script, command, verdict: 'safe' as const };
    });
}

export function scanMarkdownHiddenLinks(
  content: string,
): Array<{ line: number; kind: 'hidden-anchor' | 'zero-width-target'; evidence: string }> {
  const hits: Array<{ line: number; kind: 'hidden-anchor' | 'zero-width-target'; evidence: string }> = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i] ?? '';
    ANCHOR_TAG_PATTERN.lastIndex = 0;
    let anchorMatch: RegExpExecArray | null = ANCHOR_TAG_PATTERN.exec(text);
    while (anchorMatch !== null) {
      if (HIDDEN_STYLE_PATTERN.test(anchorMatch[0])) {
        hits.push({ line: i + 1, kind: 'hidden-anchor', evidence: anchorMatch[0].slice(0, 160) });
        break;
      }
      anchorMatch = ANCHOR_TAG_PATTERN.exec(text);
    }

    MD_LINK_TARGET_PATTERN.lastIndex = 0;
    let linkMatch: RegExpExecArray | null = MD_LINK_TARGET_PATTERN.exec(text);
    while (linkMatch !== null) {
      if (ZERO_WIDTH_PATTERN.test(linkMatch[1] ?? '')) {
        hits.push({ line: i + 1, kind: 'zero-width-target', evidence: (linkMatch[0] ?? '').slice(0, 160) });
        break;
      }
      linkMatch = MD_LINK_TARGET_PATTERN.exec(text);
    }
  }
  return hits;
}

export function isEnvFile(fileName: string): boolean {
  return ENV_FILE_NAMES.has(fileName);
}

export class InjectionGuard {
  async scan(projectPath: string): Promise<MalwareItem[]> {
    const items: MalwareItem[] = [];
    this.walk(projectPath, 0, projectPath, items);
    return items;
  }

  private walk(dir: string, depth: number, projectPath: string, items: MalwareItem[]): void {
    if (depth > MAX_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        this.walk(fullPath, depth + 1, projectPath, items);
        continue;
      }
      if (!entry.isFile()) continue;
      this.scanFile(fullPath, entry.name, projectPath, items);
    }
  }

  private scanFile(filePath: string, fileName: string, projectPath: string, items: MalwareItem[]): void {
    if (isEnvFile(fileName)) {
      items.push(toFinding({
        type: 'suspicious-behavior',
        severity: 'medium',
        title: "'.env' file tracked in scan set",
        description: `${fileName} is present in the scanned tree and may be committed`,
        file: filePath,
        line: 0,
        pattern: fileName,
        evidence: path.relative(projectPath, filePath),
      }));
      return;
    }

    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      return;
    }

    const relFile = path.relative(projectPath, filePath);

    if (fileName === PACKAGE_JSON) {
      for (const verdict of classifyPackageJsonScripts(content)) {
        if (verdict.verdict !== 'suspicious' || !verdict.matchedPattern) continue;
        items.push(toFinding({
          type: 'supply-chain',
          severity: 'high',
          title: `Suspicious package.json script: ${verdict.script}`,
          description: `Script '${verdict.script}' matched suspicious shell pattern (${verdict.matchedPattern})`,
          file: filePath,
          line: 0,
          pattern: verdict.matchedPattern,
          evidence: verdict.command.slice(0, 160),
        }));
      }
      return;
    }

    const ext = path.extname(fileName).toLowerCase();
    if (ext === MARKDOWN_EXT) {
      for (const hit of scanMarkdownHiddenLinks(content)) {
        items.push(toFinding({
          type: 'suspicious-behavior',
          severity: 'medium',
          title: `Hidden markdown link (${hit.kind})`,
          description: `Markdown doc embeds hidden/misleading link in ${relFile}`,
          file: filePath,
          line: hit.line,
          pattern: hit.kind,
          evidence: hit.evidence,
        }));
      }
    }

    if (LINE_COMMENT_PREFIX.has(ext) || BLOCK_COMMENT_DELIMS.has(ext)) {
      for (const hit of scanCommentInstructions(content, ext)) {
        items.push(toFinding({
          type: 'suspicious-behavior',
          severity: 'high',
          title: 'Prompt-instruction embedded in comment',
          description: `Comment matches AI instruction pattern (${hit.matchedPattern}) in ${relFile}`,
          file: filePath,
          line: hit.line,
          pattern: hit.matchedPattern,
          evidence: hit.evidence,
        }));
      }
    }
  }
}
