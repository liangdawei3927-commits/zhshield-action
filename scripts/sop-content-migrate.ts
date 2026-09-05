#!/usr/bin/env node
/**
 * 规则内容迁移脚本（05-规则内容仓库与管理后台.md §四, C2）
 *
 * 把 90 条规则 + tool-packs 4 工具包搬进数据库（better-sqlite3）。
 * 规则源位于 packages/kernel/test-fixtures/sop-content/{rules,tool-packs}
 * （C6 后产品源码内不再内置规则，fixture 保留完整副本作为种子化/灾备重建来源）。
 *
 * H1 硬约束：content_sha 必须 = computeRuleContentSha(SopRule)，禁止另起口径
 * （否则客户端 verifyRuleManifest 对账误判 shaMismatch → 假漂移自愈）。
 *
 * 用法:
 *   tsx scripts/sop-content-migrate.ts --check     # 只读先验：扫描源、不写库
 *   tsx scripts/sop-content-migrate.ts --apply     # 入库（幂等 upsert + 写历史+audit）
 *   tsx scripts/sop-content-migrate.ts --verify    # 比对 DB content_sha 集合 vs 源扫描
 *
 * 设计（§4.2）：只读不改源码；失败可清表重跑；`--verify` 比 content_sha 集合、不比签名整包。
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { SopRegistry, SopLoader, computeRuleContentSha, hashToolRuleFiles } from '../packages/kernel/dist/index.js';
import type { SopRule } from '../packages/kernel/dist/index.js';
import { ToolRuleLoader } from '../packages/server/src/sop/tool-rule-loader';

const ROOT = path.resolve(import.meta.dirname, '..');
// C6 后源 yml 已从 src/sop 移除；test-fixtures/sop-content 保有 94 文件完整副本。
// 此目录同时作为新环境种子化 / 灾备重建的规则源（蓝图 §4.3 快照未实施的等效替代）。
const CONTENT_DIR = path.join(ROOT, 'packages', 'kernel', 'test-fixtures', 'sop-content');
const RULES_DIR = path.join(CONTENT_DIR, 'rules');
const TOOL_PACKS_DIR = path.join(CONTENT_DIR, 'tool-packs');
const DB_PATH =
  process.env.ZH_SERVER_DB ??
  path.join(os.homedir(), '.zhshield', 'server', 'zh-codeshield.db');

const OPERATOR = 'migration-c2';
const INITIAL_VERSION = '1.0.0';

// ─── 模式分支 ───────────────────────────────────────────────

const mode = process.argv[2] ?? '--check';
if (!['--check', '--apply', '--verify'].includes(mode)) {
  console.error(`usage: tsx scripts/sop-content-migrate.ts [--check|--apply|--verify]`);
  process.exit(1);
}

// ─── 源端扫描（规则：SopLoader+SopRegistry；工具：ToolRuleLoader + hashToolRuleFiles）───

// SopLoader API 是 async；以 async 主函数承载
async function main(): Promise<void> {
  const registry = new SopRegistry();
  const loader = new SopLoader(registry, { rulesDir: RULES_DIR });
  const loaded = await loader.loadFromDirectory(RULES_DIR, true);
  const rules = registry.getAll();
  console.log(`[scan] 规则源扫描: ${loaded} 文件 → registry ${rules.length} 条`);

  const toolLoader = new ToolRuleLoader(TOOL_PACKS_DIR);
  const toolIds = fs.existsSync(TOOL_PACKS_DIR)
    ? fs
        .readdirSync(TOOL_PACKS_DIR, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
    : [];
  const tools = toolIds.map((toolId) => {
    const files = toolLoader.loadToolRuleFiles(toolId);
    return { toolId, files, sha256: hashToolRuleFiles(files) };
  });
  console.log(`[scan] 工具源扫描: ${tools.length} 个工具包`);

  if (mode === '--check') {
    const domainCounts: Record<string, number> = {};
    for (const r of rules) domainCounts[r.domain] = (domainCounts[r.domain] ?? 0) + 1;
    console.log('[check] 通过（未写库）');
    console.log('[check] 域分布:', JSON.stringify(domainCounts));
    console.log('[check] 工具:', tools.map((t) => `${t.toolId}(${t.files.length} 文件)`).join(', '));
    process.exit(0);
  }

  const db = openDb();
  try {
    if (mode === '--verify') {
      verify(db, rules, tools);
    } else {
      apply(db, rules, tools);
    }
  } finally {
    db.close();
  }
}

// ─── DB 开闭 ───────────────────────────────────────────────

function openDb(): Database.Database {
  if (!existsSync(DB_PATH)) {
    console.error(`[db] 数据库不存在: ${DB_PATH}（先启动一次服务端或手动跑迁移）`);
    process.exit(1);
  }
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

// ─── 入库（幂等 upsert）────────────────────────────────────

function apply(
  db: Database.Database,
  rules: SopRule[],
  tools: { toolId: string; files: { filename: string; content: string }[]; sha256: string }[],
): void {
  const insertRule = db.prepare(`
    INSERT INTO rule_content (
      id, rule_id, domain, action, source, name, description, severity, status,
      execution_mode, tags, applicable_engines, languages, frameworks,
      tool_id, tool_version, content, content_sha, version, created_by, updated_by
    ) VALUES (
      @id, @rule_id, @domain, @action, @source, @name, @description, @severity, @status,
      @execution_mode, @tags, @applicable_engines, @languages, @frameworks,
      @tool_id, @tool_version, @content, @content_sha, @version, @created_by, @updated_by
    )
    ON CONFLICT(rule_id) DO UPDATE SET
      domain = excluded.domain, action = excluded.action, source = excluded.source,
      name = excluded.name, description = excluded.description,
      severity = excluded.severity, status = excluded.status,
      execution_mode = excluded.execution_mode, tags = excluded.tags,
      applicable_engines = excluded.applicable_engines, languages = excluded.languages,
      frameworks = excluded.frameworks, tool_id = excluded.tool_id,
      tool_version = excluded.tool_version, content = excluded.content,
      content_sha = excluded.content_sha, version = excluded.version,
      created_by = excluded.created_by, updated_by = excluded.updated_by,
      updated_at = CURRENT_TIMESTAMP`);

  const insertVersion = db.prepare(`
    INSERT INTO rule_content_version (id, rule_id, version, content_sha, content, status_at_release, released_by, changes)
    VALUES (@id, @rule_id, @version, @content_sha, @content, @status_at_release, @released_by, @changes)
    ON CONFLICT(rule_id, version) DO NOTHING`);

  const insertTool = db.prepare(`
    INSERT INTO tool_package (
      id, tool_id, version, sha256, files_json, languages, frameworks, status, description, created_by
    ) VALUES (@id, @tool_id, @version, @sha256, @files_json, @languages, @frameworks, @status, @description, @created_by)
    ON CONFLICT(tool_id) DO UPDATE SET
      version = excluded.version, sha256 = excluded.sha256, files_json = excluded.files_json,
      languages = excluded.languages, frameworks = excluded.frameworks,
      status = excluded.status, description = excluded.description`);

  const insertToolVersion = db.prepare(`
    INSERT INTO tool_package_version (id, tool_id, version, sha256, files_json, languages, frameworks, released_by, changes)
    VALUES (@id, @tool_id, @version, @sha256, @files_json, @languages, @frameworks, @released_by, @changes)
    ON CONFLICT(tool_id, version) DO NOTHING`);

  const insertAudit = db.prepare(`
    INSERT INTO content_audit_log (id, entity_type, entity_id, action, detail, operator)
    VALUES (@id, @entity_type, @entity_id, @action, @detail, @operator)`);

  const tx = db.transaction(() => {
    // 幂等：audit 仅对真正新插入的行记录，重跑不重复追加
    const existingRuleIds = new Set(
      (db.prepare('SELECT rule_id FROM rule_content').all() as { rule_id: string }[]).map(
        (r) => r.rule_id,
      ),
    );
    const existingToolIds = new Set(
      (db.prepare('SELECT tool_id FROM tool_package').all() as { tool_id: string }[]).map(
        (t) => t.tool_id,
      ),
    );

    for (const rule of rules) {
      const contentSha = computeRuleContentSha(rule);
      const serialized = JSON.stringify(rule);
      const isNew = !existingRuleIds.has(rule.id);
      insertRule.run({
        id: rule.id,
        rule_id: rule.id,
        domain: rule.domain,
        action: rule.action,
        source: rule.source,
        name: rule.name,
        description: rule.description ?? null,
        severity: rule.severity,
        status: rule.status,
        execution_mode: rule.executionMode,
        tags: JSON.stringify(rule.tags ?? []),
        applicable_engines: JSON.stringify(rule.applicableEngines ?? []),
        languages: JSON.stringify(rule.serves?.languages ?? []),
        frameworks: JSON.stringify([]),
        tool_id: null,
        tool_version: null,
        content: serialized,
        content_sha: contentSha,
        version: INITIAL_VERSION,
        created_by: OPERATOR,
        updated_by: OPERATOR,
      });
      insertVersion.run({
        id: randomUUID(),
        rule_id: rule.id,
        version: INITIAL_VERSION,
        content_sha: contentSha,
        content: serialized,
        status_at_release: rule.status,
        released_by: OPERATOR,
        changes: 'C2 初始迁移',
      });
      if (isNew) {
        insertAudit.run({
          id: randomUUID(),
          entity_type: 'rule',
          entity_id: rule.id,
          action: 'create',
          detail: `migrate content_sha=${contentSha.slice(0, 12)} version=${INITIAL_VERSION}`,
          operator: OPERATOR,
        });
      }
    }

    for (const tool of tools) {
      const version = `1.${tool.sha256.slice(0, 12)}`;
      const filesJson = JSON.stringify(tool.files);
      const isNew = !existingToolIds.has(tool.toolId);
      insertTool.run({
        id: randomUUID(),
        tool_id: tool.toolId,
        version,
        sha256: tool.sha256,
        files_json: filesJson,
        languages: JSON.stringify([]),
        frameworks: JSON.stringify([]),
        status: 'active',
        description: null,
        created_by: OPERATOR,
      });
      insertToolVersion.run({
        id: randomUUID(),
        tool_id: tool.toolId,
        version,
        sha256: tool.sha256,
        files_json: filesJson,
        languages: JSON.stringify([]),
        frameworks: JSON.stringify([]),
        released_by: OPERATOR,
        changes: 'C2 初始迁移',
      });
      if (isNew) {
        insertAudit.run({
          id: randomUUID(),
          entity_type: 'tool',
          entity_id: tool.toolId,
          action: 'create',
          detail: `migrate sha256=${tool.sha256.slice(0, 12)} version=${version}`,
          operator: OPERATOR,
        });
      }
    }
  });

  tx();
  const ruleRows = db.prepare('SELECT count(*) AS c FROM rule_content').get() as { c: number };
  const toolRows = db.prepare('SELECT count(*) AS c FROM tool_package').get() as { c: number };
  const auditRows = db.prepare('SELECT count(*) AS c FROM content_audit_log').get() as { c: number };
  console.log(`[apply] 完成: rule_content=${ruleRows.c} tool_package=${toolRows.c} audit=${auditRows.c}`);
}

// ─── 比对（§4.2 口径：content_sha 集合逐条相等）────────────

function verify(
  db: Database.Database,
  rules: SopRule[],
  tools: { toolId: string; files: { filename: string; content: string }[]; sha256: string }[],
): void {
  const expectedShas = new Map(rules.map((r) => [r.id, computeRuleContentSha(r)]));
  const dbRules = db.prepare('SELECT rule_id, content_sha FROM rule_content').all() as {
    rule_id: string;
    content_sha: string;
  }[];
  const dbSnaps = new Map(dbRules.map((r) => [r.rule_id, r.content_sha]));

  let ok = true;
  for (const [ruleId, sha] of expectedShas) {
    const dbSha = dbSnaps.get(ruleId);
    if (dbSha !== sha) {
      ok = false;
      console.error(
        `[verify] MISMATCH 规则 ${ruleId}: 源=${sha.slice(0, 12)} db=${dbSha?.slice(0, 12) ?? '缺失'}`,
      );
    }
  }
  for (const ruleId of dbSnaps.keys()) {
    if (!expectedShas.has(ruleId)) {
      ok = false;
      console.error(`[verify] UNEXPECTED db 规则 ${ruleId}（源中不存在）`);
    }
  }
  const expectedToolShas = new Map(tools.map((t) => [t.toolId, t.sha256]));
  const dbTools = db.prepare('SELECT tool_id, sha256 FROM tool_package').all() as {
    tool_id: string;
    sha256: string;
  }[];
  for (const [toolId, sha] of expectedToolShas) {
    const dbSha = dbTools.find((t) => t.tool_id === toolId)?.sha256;
    if (dbSha !== sha) {
      ok = false;
      console.error(
        `[verify] MISMATCH 工具 ${toolId}: 源=${sha.slice(0, 12)} db=${dbSha?.slice(0, 12) ?? '缺失'}`,
      );
    }
  }
  console.log(
    `[verify] 规则 ${expectedShas.size} 条 / 工具 ${expectedToolShas.size} 个 比对完成: ${
      ok ? '全部一致 ✓' : '存在不一致 ✗'
    }`,
  );
  if (!ok) process.exitCode = 1;
}

// ─── 迁移前确保 DB 就绪（复用 @zh/db 迁移执行器，_migrations 跳过已应用 → 幂等）────

function ensureDb(): void {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // cwd 必须在依赖 @zh/db 的包内（如 server），根 node_modules 无 workspace 链接
  const serverDir = path.join(ROOT, 'packages', 'server');
  try {
    execSync(
      `node -e "const {initDatabase}=require('@zh/db');initDatabase({dbPath:process.env.ZH_SERVER_DB});"`,
      { env: { ...process.env, ZH_SERVER_DB: DB_PATH }, cwd: serverDir, stdio: 'inherit' },
    );
  } catch (err) {
    // 迁移失败（如历史 SQLite 版本创建的库对 011 的 ADD COLUMN 非恒定默认值不兼容）时，
    // 若 --verify 所需的表已存在则降级继续（verify 只读 rule_content/tool_package，不依赖新列）
    const db = new Database(DB_PATH, { readonly: true });
    const tables = new Set(
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
      ).map((r) => r.name),
    );
    db.close();
    if (tables.has('rule_content') && tables.has('tool_package')) {
      console.warn(`[db] 迁移未完全应用（${String((err as Error).message).split('\n')[0]}），所需表已存在，继续`);
    } else {
      throw err;
    }
  }
}

ensureDb();
void main();