/**
 * AI 来源检测器（origin-detector.ts）
 *
 * 附 E.5 检测信号源：commit-meta / style-signature / user-tagged / tool-report，
 * 输出可解释证据分级（strong / suggestive / uncertain），不做概率黑盒（边界 1）。
 *
 * 分级语义（E.2）：
 * - strong      = 多类证据一致（commit 标记 + 风格突变 + 用户标注）
 * - suggestive  = 单类强证据或弱证据组合
 * - uncertain   = 特征存在但不充分 → 不标记为 AI 生成，仅提示（边界 2）
 */
import { execFile } from 'child_process';
import { promisify } from 'util';

import type { ProjectProfile } from '@zh/dependency';

import { readTextFileSafe, walkSourceFiles } from './files';
import { analyzeStyleSignature } from './style-signature';
import type { AiEvidence, AiOriginFinding, AiStrength, AiToolReport, AiUserTag } from './types';

const execFileAsync = promisify(execFile);

/** git 提交证据：解析 git log 输出的单条提交 */
export interface CommitEvidence {
  author: string;
  /** unix 秒 */
  timestamp: number;
  subject: string;
  hash: string;
  files: string[];
}

/** AI 工具提交信息标记（subject 命中即 commit-meta 强信号） */
const AI_COMMIT_MARKERS: readonly RegExp[] = [
  /generated\s+by\s+(?:openai|chatgpt|gpt|copilot|claude|codeium|cursor|tabnine|bard|gemini)/i,
  /\bgpt-\d+\b|\bchatgpt\b|\b(?:github\s+)?copilot\b|\bclaude\b|\bcodeium\b|\btabnine\b/i,
];

/** 单提交文件数 ≥ 阈值视为"批量粘贴"模式（弱信号） */
const BATCH_FILES_THRESHOLD = 20;

/** 同一作者 600 秒内 ≥ 5 次提交视为"快速批量提交"模式（弱信号） */
const BURST_WINDOW_SECONDS = 600;
const BURST_MIN_COMMITS = 5;

/** 检测选项：可选输入信号（user-tagged 为唯一确定性信号） */
export interface AiOriginDetectorOptions {
  userTags?: readonly AiUserTag[];
  toolReports?: readonly AiToolReport[];
  /** 是否包含 uncertain 分级结果（默认 false：不硬猜，边界 2） */
  includeUncertain?: boolean;
  /** git log 取最近提交数上限（默认 200） */
  maxCommits?: number;
}

/** AI 来源检测器契约（E.5 信号源聚合） */
export interface AiOriginDetector {
  detect(project: ProjectProfile, options?: AiOriginDetectorOptions): Promise<readonly AiOriginFinding[]>;
}

/**
 * 纯函数：解析 `git log --pretty=format:%an\x1f%at\x1f%s\x1f%H --name-only` 输出
 * 为提交证据列表。块 = 空行分隔；首行为头，其余为文件名。
 */
export function commitEvidenceFromLog(output: string): CommitEvidence[] {
  const blocks = output.split(/\n\s*\n/);
  const commits: CommitEvidence[] = [];
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).filter((l) => l.length > 0);
    const header = lines[0];
    if (header === undefined) continue;
    const parts = header.split('\x1f');
    const author = parts[0];
    const at = parts[1];
    const subject = parts[2];
    const hash = parts[3];
    if (author === undefined || at === undefined || subject === undefined || hash === undefined) continue;
    const timestamp = Number(at);
    if (!Number.isFinite(timestamp)) continue;
    commits.push({ author, timestamp, subject, hash, files: lines.slice(1) });
  }
  return commits;
}

/** 提交是否含 AI 工具标记 */
export function isAiMarkedCommit(subject: string): boolean {
  return AI_COMMIT_MARKERS.some((re) => re.test(subject));
}

/** 同作者 600 秒内提交数 ≥ 5（按索引输出命中提交集） */
function burstCommitIndexes(commits: readonly CommitEvidence[]): ReadonlySet<number> {
  const burst = new Set<number>();
  const byAuthor = new Map<string, number[]>();
  commits.forEach((c, i) => {
    const arr = byAuthor.get(c.author);
    if (arr === undefined) byAuthor.set(c.author, [i]);
    else arr.push(i);
  });
  for (const indexes of byAuthor.values()) {
    const sorted = [...indexes].sort((a, b) => commits[a].timestamp - commits[b].timestamp);
    for (let i = 0; i < sorted.length; i++) {
      const start = sorted[i];
      let count = 1;
      for (let j = i + 1; j < sorted.length; j++) {
        if (commits[sorted[j]].timestamp - commits[start].timestamp > BURST_WINDOW_SECONDS) break;
        count += 1;
      }
      if (count >= BURST_MIN_COMMITS) {
        for (let k = i; k < i + count; k++) burst.add(sorted[k]);
      }
    }
  }
  return burst;
}

/**
 * 运行只读 git log（不修改仓库）；git 不可用 / 非 git 仓库 → null（降级为空，不抛错）。
 * 注意：本文件是唯一允许的 git 子进程（P0-2 禁令除外项）。
 */
async function runGitLog(projectPath: string, maxCommits: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', projectPath, 'log', '--no-merges', '--no-renames', `--pretty=format:%an\x1f%at\x1f%s\x1f%H`, '--name-only', `-${maxCommits}`],
      { timeout: 15_000, maxBuffer: 10 * 1024 * 1024 },
    );
    return stdout;
  } catch {
    return null; // git 不可用 → 无 commit 证据（P0-2：不抛异常，降级为空）
  }
}

/** 分级：多类证据一致 → strong；单类强证据/弱组合 → suggestive；单弱特征 → uncertain */
export function classifyStrength(evidence: readonly AiEvidence[]): AiStrength {
  if (evidence.length === 0) return 'uncertain';
  if (evidence.some((e) => e.kind === 'user-tagged')) return 'strong'; // 唯一确定性信号
  const kinds = new Set(evidence.map((e) => e.kind));
  if (kinds.size >= 2) return 'strong'; // 多类证据一致
  const kind = [...kinds][0];
  if (kind === undefined) return 'uncertain';
  if (kind === 'commit-meta' || kind === 'tool-report') return 'suggestive';
  // 单一 style-signature 类：高置信特征 → suggestive；否则看弱特征组合
  const style = evidence.filter((e) => e.kind === 'style-signature');
  if (style.some((e) => e.confidence >= 0.8)) return 'suggestive';
  return evidence.length >= 2 ? 'suggestive' : 'uncertain';
}

/** 按文件聚合 commit 证据（file → 命中 commit 的提交元证据） */
async function collectCommitEvidence(projectPath: string, maxCommits: number): Promise<Map<string, AiEvidence[]>> {
  const byFile = new Map<string, AiEvidence[]>();
  const log = await runGitLog(projectPath, maxCommits);
  if (log === null) return byFile;
  const commits = commitEvidenceFromLog(log);
  const burst = burstCommitIndexes(commits);
  commits.forEach((commit, i) => {
    const marked = isAiMarkedCommit(commit.subject);
    const isBurst = burst.has(i);
    const isBatch = commit.files.length >= BATCH_FILES_THRESHOLD;
    if (!marked && !isBurst && !isBatch) return;
    for (const file of commit.files) {
      const detail: string[] = [];
      if (marked) detail.push(`commit '${commit.subject}' carries AI-tool marker`);
      if (isBurst) detail.push(`author '${commit.author}' committed ${BURST_MIN_COMMITS}+ times within ${BURST_WINDOW_SECONDS}s`);
      if (isBatch) detail.push(`commit touches ${commit.files.length} files (bulk paste pattern)`);
      if (detail.length === 0) continue;
      const arr = byFile.get(file);
      const evidence: AiEvidence = {
        kind: 'commit-meta',
        detail: detail.join('; '),
        confidence: marked ? 0.7 : 0.45,
      };
      if (arr === undefined) byFile.set(file, [evidence]);
      else arr.push(evidence);
    }
  });
  return byFile;
}

/** AI 来源检测实现：聚合四类信号，按分级输出 */
export class AiOriginDetectorImpl implements AiOriginDetector {
  async detect(project: ProjectProfile, options: AiOriginDetectorOptions = {}): Promise<readonly AiOriginFinding[]> {
    const projectPath = project.projectPath;
    const includeUncertain = options.includeUncertain ?? false;
    const maxCommits = options.maxCommits ?? 200;

    const files = new Set(walkSourceFiles(projectPath));
    const evidenceByFile = new Map<string, AiEvidence[]>();
    const addEvidence = (file: string, evidence: AiEvidence): void => {
      const arr = evidenceByFile.get(file);
      if (arr === undefined) evidenceByFile.set(file, [evidence]);
      else arr.push(evidence);
    };

    // 1) commit-meta：git 提交元数据（批量快速提交 + AI 工具标记）
    const commitEvidence = await collectCommitEvidence(projectPath, maxCommits);
    for (const [file, evidence] of commitEvidence) {
      if (!files.has(file)) continue;
      for (const e of evidence) addEvidence(file, e);
    }

    // 2) style-signature：风格突变 / 模板化命名 / AI 典型注释
    for (const file of files) {
      const content = readTextFileSafe(projectPath, file);
      if (content === null) continue;
      for (const signal of analyzeStyleSignature(content)) {
        addEvidence(file, {
          kind: 'style-signature',
          detail: signal.detail,
          confidence: signal.confidence,
        });
      }
    }

    // 3) user-tagged：用户主动标注（唯一确定性信号）
    for (const tag of options.userTags ?? []) {
      if (!files.has(tag.file)) continue;
      addEvidence(tag.file, {
        kind: 'user-tagged',
        detail: tag.source !== undefined ? `user marked as AI-generated (${tag.source})` : 'user marked as AI-generated',
        confidence: 1,
      });
    }

    // 4) tool-report：IDE/AI 工具生成物报告
    for (const report of options.toolReports ?? []) {
      if (!files.has(report.file)) continue;
      addEvidence(report.file, {
        kind: 'tool-report',
        detail: `tool report: ${report.detail}`,
        confidence: 0.6,
      });
    }

    const findings: AiOriginFinding[] = [];
    for (const [file, evidence] of evidenceByFile) {
      const strength = classifyStrength(evidence);
      if (strength === 'uncertain' && !includeUncertain) continue; // 边界 2：不硬猜
      findings.push({ findingId: `ai-origin-${findings.length}`, file, evidence, strength });
    }

    // strong → suggestive → uncertain；同强度按文件名
    const rank: Record<AiStrength, number> = { strong: 0, suggestive: 1, uncertain: 2 };
    findings.sort((a, b) => rank[a.strength] - rank[b.strength] || a.file.localeCompare(b.file));
    return findings;
  }
}
