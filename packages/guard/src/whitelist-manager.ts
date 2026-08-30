import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

const RULE_LINE = /rule:\s*['"]?(.+?)['"]?$/;
const REASON_LINE = /reason:\s*['"]?(.+?)['"]?$/;
const EXPIRES_LINE = /expiresAt:\s*['"]?(.+?)['"]?$/;
const PATH_LINE = /path:\s*['"]?(.+?)['"]?$/;
const PATTERN_LINE = /pattern:\s*['"]?(.+?)['"]?$/;

export interface WhitelistEntry {
  id: string;
  projectId: string;
  scope: 'project' | 'file' | 'rule';
  target: string;
  ruleId?: string;
  reason: string;
  operator: string;
  expiresAt?: string;
  createdAt: string;
}

export interface WhitelistConfig {
  whitelist: {
    project?: Array<{ rule: string; reason: string; expiresAt?: string }>;
    file?: Array<{ path: string; rules: string[]; reason: string }>;
    rule?: Array<{ rule: string; pattern: string; reason: string }>;
  };
}

type WhitelistSection = 'project' | 'file' | 'rule';

interface LineParseContext {
  config: WhitelistConfig;
  trimmed: string;
  current?: { rule?: string; reason?: string; expiresAt?: string; path?: string; rules?: string[]; pattern?: string } | null;
}

/** 各 section 的行解析器，按 section 分发（无状态纯函数） */
const SECTION_PARSERS: Record<WhitelistSection, (ctx: LineParseContext) => void> = {
  project: parseProjectLine,
  file: parseFileLine,
  rule: parseRuleLine,
};

/** 解析 YAML-like 白名单内容为 WhitelistEntry 列表 */
function parseWhitelistYaml(content: string): WhitelistEntry[] {
  const config: WhitelistConfig = { whitelist: {} };
  const ctx: LineParseContext = { config, trimmed: '', current: null };
  let section: WhitelistSection | null = null;

  for (const line of content.split('\n')) {
    section = parseWhitelistLine(ctx, section, line);
  }

  return configToEntries(config);
}

/** 解析单行：跳过注释与 section 头，其余交给对应 section 解析器，返回更新后的 section */
function parseWhitelistLine(
  ctx: LineParseContext,
  section: WhitelistSection | null,
  line: string,
): WhitelistSection | null {
  const trimmed = line.trim();
  if (trimmed.startsWith('#')) return section;

  if (trimmed.startsWith('project:')) return 'project';
  if (trimmed.startsWith('file:')) return 'file';
  if (trimmed.startsWith('rule:')) return 'rule';

  if (!section) return section;
  ctx.trimmed = trimmed;
  SECTION_PARSERS[section](ctx);
  return section;
}

function parseProjectLine(ctx: LineParseContext): void {
  const ruleMatch = ctx.trimmed.match(RULE_LINE);
  const reasonMatch = ctx.trimmed.match(REASON_LINE);
  const expiresMatch = ctx.trimmed.match(EXPIRES_LINE);
  if (ruleMatch) {
    ctx.current = { rule: ruleMatch[1], reason: '' };
    addProjectEntry(ctx);
  }
  if (reasonMatch && ctx.current) ctx.current.reason = reasonMatch[1];
  if (expiresMatch && ctx.current) ctx.current.expiresAt = expiresMatch[1];
}

function addProjectEntry(ctx: LineParseContext): void {
  pushToSection(ctx, 'project');
}

function parseFileLine(ctx: LineParseContext): void {
  const pathMatch = ctx.trimmed.match(PATH_LINE);
  const reasonMatch = ctx.trimmed.match(REASON_LINE);
  if (pathMatch) {
    ctx.current = { path: pathMatch[1], rules: ['*'], reason: '' };
    addFileEntry(ctx);
  }
  if (reasonMatch && ctx.current) ctx.current.reason = reasonMatch[1];
}

function addFileEntry(ctx: LineParseContext): void {
  pushToSection(ctx, 'file');
}

function parseRuleLine(ctx: LineParseContext): void {
  const ruleMatch = ctx.trimmed.match(RULE_LINE);
  const patternMatch = ctx.trimmed.match(PATTERN_LINE);
  const reasonMatch = ctx.trimmed.match(REASON_LINE);
  if (ruleMatch) {
    ctx.current = { rule: ruleMatch[1], pattern: '', reason: '' };
    addRuleEntry(ctx);
  }
  if (patternMatch && ctx.current) ctx.current.pattern = patternMatch[1];
  if (reasonMatch && ctx.current) ctx.current.reason = reasonMatch[1];
}

function addRuleEntry(ctx: LineParseContext): void {
  pushToSection(ctx, 'rule');
}

function pushToSection(ctx: LineParseContext, section: WhitelistSection): void {
  getSectionArray(ctx.config, section).push(ctx.current);
}

function getSectionArray(config: WhitelistConfig, section: WhitelistSection): unknown[] {
  if (section === 'project') return (config.whitelist.project ??= []);
  if (section === 'file') return (config.whitelist.file ??= []);
  return (config.whitelist.rule ??= []);
}

function configToEntries(config: WhitelistConfig): WhitelistEntry[] {
  const now = new Date().toISOString();
  return [
    ...projectToEntries(config, now),
    ...fileToEntries(config, now),
    ...ruleToEntries(config, now),
  ];
}

function projectToEntries(config: WhitelistConfig, now: string): WhitelistEntry[] {
  return (config.whitelist.project || []).map((item) => ({
    id: randomUUID(),
    projectId: '',
    scope: 'project' as const,
    target: '',
    ruleId: item.rule,
    reason: item.reason,
    operator: 'config',
    expiresAt: item.expiresAt,
    createdAt: now,
  }));
}

function fileToEntries(config: WhitelistConfig, now: string): WhitelistEntry[] {
  return (config.whitelist.file || []).map((item) => ({
    id: randomUUID(),
    projectId: '',
    scope: 'file' as const,
    target: item.path,
    ruleId: item.rules?.[0],
    reason: item.reason,
    operator: 'config',
    createdAt: now,
  }));
}

function ruleToEntries(config: WhitelistConfig, now: string): WhitelistEntry[] {
  return (config.whitelist.rule || []).map((item) => ({
    id: randomUUID(),
    projectId: '',
    scope: 'rule' as const,
    target: item.pattern,
    ruleId: item.rule,
    reason: item.reason,
    operator: 'config',
    createdAt: now,
  }));
}

/** 渲染白名单 entries 为 YAML-like 内容 */
function renderWhitelistYaml(entries: WhitelistEntry[]): string {
  const projectEntries = entries.filter((e) => e.scope === 'project');
  const fileEntries = entries.filter((e) => e.scope === 'file');
  const ruleEntries = entries.filter((e) => e.scope === 'rule');

  let yaml = '# 智汇码盾白名单配置\n';
  yaml += '# 自动生成，请勿手动编辑\n\nwhitelist:\n';
  yaml += renderProjectSection(projectEntries);
  yaml += renderFileSection(fileEntries);
  yaml += renderRuleSection(ruleEntries);

  return yaml;
}

/** 渲染 project 段 YAML */
function renderProjectSection(projectEntries: WhitelistEntry[]): string {
  let yaml = '';
  if (projectEntries.length === 0) return yaml;

  yaml += '  project:\n';
  for (const e of projectEntries) {
    yaml += `    - rule: "${e.ruleId}"\n`;
    yaml += `      reason: "${e.reason}"\n`;
    if (e.expiresAt) yaml += `      expiresAt: "${e.expiresAt}"\n`;
  }
  return yaml;
}

/** 渲染 file 段 YAML */
function renderFileSection(fileEntries: WhitelistEntry[]): string {
  let yaml = '';
  if (fileEntries.length === 0) return yaml;

  yaml += '  file:\n';
  for (const e of fileEntries) {
    yaml += `    - path: "${e.target}"\n`;
    yaml += `      rules: ["${e.ruleId || '*'}"]\n`;
    yaml += `      reason: "${e.reason}"\n`;
  }
  return yaml;
}

/** 渲染 rule 段 YAML */
function renderRuleSection(ruleEntries: WhitelistEntry[]): string {
  let yaml = '';
  if (ruleEntries.length === 0) return yaml;

  yaml += '  rule:\n';
  for (const e of ruleEntries) {
    yaml += `    - rule: "${e.ruleId}"\n`;
    if (e.target) yaml += `      pattern: "${e.target}"\n`;
    yaml += `      reason: "${e.reason}"\n`;
  }
  return yaml;
}

export class WhitelistManager {
  private entries: WhitelistEntry[] = [];
  private filePath: string;

  constructor(projectPath: string) {
    this.filePath = path.join(projectPath, '.zhshield', 'whitelist.yml');
  }

  async load(): Promise<void> {
    try {
      await fs.promises.access(this.filePath);
      const content = await fs.promises.readFile(this.filePath, 'utf-8');
      this.entries = parseWhitelistYaml(content);
    } catch {
      this.entries = [];
    }
  }

  async add(entry: Omit<WhitelistEntry, 'id' | 'createdAt'>): Promise<WhitelistEntry> {
    const newEntry: WhitelistEntry = {
      ...entry,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    this.entries.push(newEntry);
    await this.save();
    return newEntry;
  }

  async remove(id: string): Promise<boolean> {
    const idx = this.entries.findIndex((e) => e.id === id);
    if (idx === -1) return false;
    this.entries.splice(idx, 1);
    await this.save();
    return true;
  }

  isWhitelisted(ruleId: string, filePath: string): { whitelisted: boolean; entry?: WhitelistEntry } {
    for (const entry of this.entries) {
      if (entry.expiresAt && new Date(entry.expiresAt) < new Date()) continue;

      if (
        this.matchesRuleEntry(entry, ruleId, filePath) ||
        this.matchesFileEntry(entry, ruleId, filePath) ||
        this.matchesProjectEntry(entry, ruleId)
      ) {
        return { whitelisted: true, entry };
      }
    }

    return { whitelisted: false };
  }

  /** 规则级白名单匹配：ruleId 一致且目标路径匹配 */
  private matchesRuleEntry(entry: WhitelistEntry, ruleId: string, filePath: string): boolean {
    if (entry.scope !== 'rule' || entry.ruleId !== ruleId) return false;
    return !entry.target || filePath.includes(entry.target);
  }

  /** 文件级白名单匹配：路径匹配且规则适用 */
  private matchesFileEntry(entry: WhitelistEntry, ruleId: string, filePath: string): boolean {
    if (entry.scope !== 'file' || !filePath.includes(entry.target)) return false;
    return !entry.ruleId || entry.ruleId === ruleId || entry.ruleId === '*';
  }

  /** 项目级白名单匹配：ruleId 一致即命中 */
  private matchesProjectEntry(entry: WhitelistEntry, ruleId: string): boolean {
    return entry.scope === 'project' && entry.ruleId === ruleId;
  }

  list(projectId?: string): WhitelistEntry[] {
    if (projectId) {
      return this.entries.filter((e) => e.projectId === projectId);
    }
    return [...this.entries];
  }

  getExpired(): WhitelistEntry[] {
    const now = new Date();
    return this.entries.filter((e) => e.expiresAt && new Date(e.expiresAt) < now);
  }

  private async save(): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.promises.mkdir(dir, { recursive: true });
    const yaml = renderWhitelistYaml(this.entries);
    await fs.promises.writeFile(this.filePath, yaml, 'utf-8');
  }
}
