import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MalwareItem, MalwareType } from './types';
import { PACKAGE_JSON_FILE, walkSourceTree } from './scan-walk';

const MARKDOWN_EXT = '.md';
const ENV_FILE_NAMES = new Set([
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '.env.test',
]);

const LINE_COMMENT_PREFIX = new Map<string, string>([
  ['.ts', '//'],
  ['.tsx', '//'],
  ['.js', '//'],
  ['.jsx', '//'],
  ['.mjs', '//'],
  ['.cjs', '//'],
  ['.py', '#'],
]);

const BLOCK_COMMENT_DELIMS = new Map<string, readonly [string, string]>([
  ['.ts', ['/*', '*/']],
  ['.tsx', ['/*', '*/']],
  ['.js', ['/*', '*/']],
  ['.jsx', ['/*', '*/']],
  ['.mjs', ['/*', '*/']],
  ['.cjs', ['/*', '*/']],
  ['.md', ['<!--', '-->']],
]);

/**
 * 需要读取内容才有检测项的扩展名集合。
 *
 * 由三类检测共同决定：markdown 隐藏链接、注释内容扫描、以及 package.json 脚本判定
 * （后者按文件名匹配，单独判断）。**其余扩展名读完没有任何后续动作** —— 旧实现
 * 先无条件 `readFileSync(filePath, 'utf-8')` 再按扩展名分支，等于把 .dmg / .zip / .png /
 * .db 也整份解码成 JS 字符串。
 *
 * 2026-11-15 实测（桌面端扫描 `Desktop/ZHCodeShield`，300mm 级项目）：一次 walk 读
 * 2176 个文件 / 682 MB，其中 `.dmg` 3 个 514 MB、`.zip` 3 个 152 MB；真正会被检测的
 * 源码/文档合计仅约 11 MB。安全域里该 walk 一次扫描跑 3 遍（SecurityEngine 聚合器 +
 * 2 条 SOP `security-check` 规则经 SecurityCheckEngine），CPU profile 分别为 17.5s /
 * 34.1s / 210.4s（越跑越慢：666 MB 二进制解码出的字符串堆叠未回收），合计 262s，
 * 把 `SCAN_DOMAIN_BUDGETS.security` 的 300s 预算吃满 → 域恒 `unavailable`。
 */
const CONTENT_SCANNED_EXTS: ReadonlySet<string> = new Set([
  MARKDOWN_EXT,
  ...LINE_COMMENT_PREFIX.keys(),
  ...BLOCK_COMMENT_DELIMS.keys(),
]);

/** 单文件读取上限（1 MB）：与 kernel `readFileSafe` 同口径，超大文件skip，避免撑爆堆 */
const MAX_CONTENT_FILE_BYTES = 1_048_576;

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

// npm 惯例 clean 类脚本允许删除的构建产物目标（纯产物目录/文件），
// 其余 rm -rf 目标（.、/、~、*、../../、./tmp 等）维持 force-delete 告警
const SAFE_RM_RF_TARGET =
  /^(?:\.\/)?(?:dist(?:-\w+)?|build|coverage|\.turbo|\.next|\.cache|release|node_modules|lib|out|esm|cjs)(?:\/)?(?:\/\*)?$|^.*\.tsbuildinfo$/;

const COMMAND_SEGMENT_SPLIT_RE = /[&|;]/;
const TOKEN_SPLIT_RE = /\s+/;

function isRoutineCleanCommand(command: string): boolean {
  for (const segment of command.split(COMMAND_SEGMENT_SPLIT_RE)) {
    const tokens = segment.trim().split(TOKEN_SPLIT_RE);
    const rfIdx = tokens.findIndex((t) => t === '-rf' || t === '-fr');
    if (rfIdx < 0) continue;
    const targets = tokens.slice(rfIdx + 1).filter((t) => t !== '' && !t.startsWith('-'));
    if (targets.length === 0 || !targets.every((t) => SAFE_RM_RF_TARGET.test(t))) return false;
  }
  return true;
}

const HIDDEN_STYLE_PATTERN =
  /display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?:px)?\s*[;'"}]/i;
const ANCHOR_TAG_PATTERN = /<a\b[^>]*>/gi;
const MD_LINK_TARGET_PATTERN = /\[[^\]]*\]\(([^)]*)\)/g;

const ZERO_WIDTH_PATTERN = new RegExp('\\u200B|\\u200C|\\u200D|\\u2060|\\uFEFF');

/** package.json 单条脚本的判定结果：命令文本 + safe/suspicious 结论 + 命中的模式名 */
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
      const matched = SCRIPT_SUSPICIOUS_PATTERNS.find(
        ([name, pattern]) =>
          pattern.test(command) && !(name === 'force-delete' && isRoutineCleanCommand(command)),
      );
      return matched
        ? { script, command, verdict: 'suspicious' as const, matchedPattern: matched[0] }
        : { script, command, verdict: 'safe' as const };
    });
}

export function scanMarkdownHiddenLinks(
  content: string,
): Array<{ line: number; kind: 'hidden-anchor' | 'zero-width-target'; evidence: string }> {
  const hits: Array<{
    line: number;
    kind: 'hidden-anchor' | 'zero-width-target';
    evidence: string;
  }> = [];
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
        hits.push({
          line: i + 1,
          kind: 'zero-width-target',
          evidence: (linkMatch[0] ?? '').slice(0, 160),
        });
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

interface ScanCommentHitsParams {
  filePath: string;
  relFile: string;
  content: string;
  ext: string;
  items: MalwareItem[];
}

export class InjectionGuard {
  async scan(projectPath: string): Promise<MalwareItem[]> {
    const items: MalwareItem[] = [];
    walkSourceTree(projectPath, (fullPath, fileName) =>
      this.scanFile(fullPath, fileName, projectPath, items),
    );
    return items;
  }

  private scanFile(
    filePath: string,
    fileName: string,
    projectPath: string,
    items: MalwareItem[],
  ): void {
    if (isEnvFile(fileName)) {
      items.push(
        toFinding({
          type: 'suspicious-behavior',
          severity: 'medium',
          title: "'.env' file tracked in scan set",
          description: `${fileName} is present in the scanned tree and may be committed`,
          file: filePath,
          line: 0,
          pattern: fileName,
          evidence: path.relative(projectPath, filePath),
        }),
      );
      return;
    }

    // 先按扩展名筛、再读内容（顺序颠倒是 2026-11-15 的生产事故成因，见 CONTENT_SCANNED_EXTS）
    const ext = path.extname(fileName).toLowerCase();
    const isPackageJson = fileName === PACKAGE_JSON_FILE;
    if (!isPackageJson && !CONTENT_SCANNED_EXTS.has(ext)) return;

    const content = this.readFileContent(filePath);
    if (content === null) return;
    const relFile = path.relative(projectPath, filePath);

    if (isPackageJson) {
      this.scanPackageJsonScripts(filePath, content, items);
      return;
    }

    if (ext === MARKDOWN_EXT) {
      this.scanMarkdownFile(filePath, relFile, content, items);
    }
    if (LINE_COMMENT_PREFIX.has(ext) || BLOCK_COMMENT_DELIMS.has(ext)) {
      this.scanCommentHits({ filePath, relFile, content, ext, items });
    }
  }

  private readFileContent(filePath: string): string | null {
    try {
      // 大小闸门与扩展名白名单是两道独立防线：将来若有人把大文件改名成 .md/.js，
      // 也不会再把整份内容读进堆里（同口径见 kernel `readFileSafe` 的 1 MB 上限）
      if (fs.statSync(filePath).size > MAX_CONTENT_FILE_BYTES) return null;
      return fs.readFileSync(filePath, 'utf-8');
    } catch {
      return null;
    }
  }

  private scanPackageJsonScripts(filePath: string, content: string, items: MalwareItem[]): void {
    for (const verdict of classifyPackageJsonScripts(content)) {
      if (verdict.verdict !== 'suspicious' || !verdict.matchedPattern) continue;
      items.push(
        toFinding({
          type: 'supply-chain',
          severity: 'high',
          title: `Suspicious package.json script: ${verdict.script}`,
          description: `Script '${verdict.script}' matched suspicious shell pattern (${verdict.matchedPattern})`,
          file: filePath,
          line: 0,
          pattern: verdict.matchedPattern,
          evidence: verdict.command.slice(0, 160),
        }),
      );
    }
  }

  private scanMarkdownFile(
    filePath: string,
    relFile: string,
    content: string,
    items: MalwareItem[],
  ): void {
    for (const hit of scanMarkdownHiddenLinks(content)) {
      items.push(
        toFinding({
          type: 'suspicious-behavior',
          severity: 'medium',
          title: `Hidden markdown link (${hit.kind})`,
          description: `Markdown doc embeds hidden/misleading link in ${relFile}`,
          file: filePath,
          line: hit.line,
          pattern: hit.kind,
          evidence: hit.evidence,
        }),
      );
    }
  }

  private scanCommentHits(params: ScanCommentHitsParams): void {
    const { filePath, relFile, content, ext, items } = params;
    for (const hit of scanCommentInstructions(content, ext)) {
      items.push(
        toFinding({
          type: 'suspicious-behavior',
          severity: 'high',
          title: 'Prompt-instruction embedded in comment',
          description: `Comment matches AI instruction pattern (${hit.matchedPattern}) in ${relFile}`,
          file: filePath,
          line: hit.line,
          pattern: hit.matchedPattern,
          evidence: hit.evidence,
        }),
      );
    }
  }
}
