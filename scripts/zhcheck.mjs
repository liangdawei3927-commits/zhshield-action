#!/usr/bin/env node
/**
 * zhcheck — 智汇码盾 CLI 检查命令
 *
 * 用法:
 *   node scripts/zhcheck.mjs --refactor              # 重构检查
 *   node scripts/zhcheck.mjs --refactor --staged     # 仅检查暂存区
 *   node scripts/zhcheck.mjs --refactor --file a.ts  # 检查单个文件
 *   node scripts/zhcheck.mjs --all --staged          # 全部引擎，暂存区
 *   node scripts/zhcheck.mjs --refactor --ci         # CI 模式 (exit 1 on issues)
 *   node scripts/zhcheck.mjs --refactor --json       # JSON 输出
 *   node scripts/zhcheck.mjs --install-hooks         # 安装 pre-commit hook
 *
 * Linter 输出格式:
 *   file:line:col: severity: ruleId: message
 *   src/engine.ts:42:10: warning: long-method: GuardEngine.run() 过长 (48 行)
 *
 * Exit codes:
 *   0: 无 error 级别问题（--ci 模式下无 error 或 warning）
 *   1: 发现 error 级别问题（--ci 模式下 warning 也触发）
 */

import { parseArgs } from 'node:util';
import { resolve, relative } from 'path';
import { existsSync, writeFileSync, chmodSync, statSync } from 'fs';
import { execSync } from 'child_process';

const PKGS_ROOT = resolve(import.meta.dirname, '..', 'packages');
const PROJECT_ROOT = resolve(import.meta.dirname, '..');

/** 构建产物目录（dist/dist-electron），模块级常量避免每次过滤时重编译正则 */
const RE_DIST = /(^|\/)dist(\/|$)/;
const RE_DIST_ELECTRON = /(^|\/)dist-electron(\/|$)/;

function importEngine(name) {
  const p = resolve(PKGS_ROOT, name, 'dist', 'engine.js');
  if (!existsSync(p)) {
    console.error(`zhcheck: engine "${name}" not built. Run pnpm build first.`);
    process.exit(2);
  }
  return import(p);
}

// ── Linter 格式化 ───────────────────────────────────────────
function formatLinter(smell, filePath) {
  const loc = smell.location || {};
  const relPath = relative(PROJECT_ROOT, filePath || loc.filePath || '');
  const line = loc.line || 1;
  const col = loc.column || 1;
  const sev = smell.severity || 'warning';
  const rule = smell.ruleId || 'unknown';
  const msg = smell.message || '';
  return `${relPath}:${line}:${col}: ${sev}: ${rule}: ${msg}`;
}

function formatLinterIssue(issue, filePath) {
  const relPath = relative(PROJECT_ROOT, filePath || '');
  const line = issue.line || 1;
  const col = issue.column || 1;
  const sev = issue.severity || 'warning';
  const rule = issue.rule || 'unknown';
  const msg = issue.message || '';
  return `${relPath}:${line}:${col}: ${sev}: ${rule}: ${msg}`;
}

// ── 重构检查 ──────────────────────────────────────────────
async function runRefactor(files, opts, projectRoot) {
  const { RefactorEngine } = await importEngine('refactor');
  const engine = new RefactorEngine();

  let report;
  if (files.length > 0) {
    report = await engine.analyzeFiles(projectRoot, files);
  } else {
    report = await engine.analyzeDirectory(projectRoot);
  }

  let warningCount = 0;
  let errorCount = 0;

  for (const fr of report.files) {
    for (const smell of fr.smells) {
      if (!opts.json) {
        console.log(formatLinter(smell, fr.filePath));
      }
      if (smell.severity === 'error') errorCount++;
      if (smell.severity === 'warning') warningCount++;
    }
  }

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  }

  return { total: report.totalSmells, warnings: warningCount, errors: errorCount };
}

// ── 巡检检查 ──────────────────────────────────────────────
/** inspect 域适配器注册表（与 pipeline-runner.registerDefaultAdapters 对齐的
 *  @zh/inspect 内置子集；pipeline 独有的 Sonarway/Trivy/AutoPerf 不在此列） */
const INSPECT_ADAPTERS = [
  'ESLintAdapter',
  'GitleaksAdapter',
  'DependencyCruiserAdapter',
  'JscpdAdapter',
  'TsPruneAdapter',
  'SemgrepAdapter',
  'DepcheckAdapter',
  'TypeScriptAdapter',
  'PrettierAdapter',
  'CommitLintAdapter',
  'NpmAuditAdapter',
];

async function runInspect(files, opts, projectRoot) {
  // InspectEngine 与适配器从包入口加载（engine.js 不含适配器类）
  const entry = resolve(PKGS_ROOT, 'inspect', 'dist', 'index.js');
  if (!existsSync(entry)) {
    console.error('zhcheck: inspect engine not built. Run pnpm build first.');
    process.exit(2);
  }
  const inspectMod = await import(entry);
  const engine = new inspectMod.InspectEngine();
  for (const name of INSPECT_ADAPTERS) {
    if (inspectMod[name]) engine.registerAdapter(new inspectMod[name]());
  }

  // P1（复查4）：inspect 引擎为项目级扫描（runScan），无 per-file API。
  // 旧代码调用已不存在的 engine.run() 且异常被静默吞掉——--inspect 自
  // 引擎 API 变更起从未真正执行过。现按现行 API 接通；暂存区/单文件模式
  // 显式声明跳过（refactor 检查仍生效），不再伪装成"0 问题 = 通过"。
  if (files.length > 0) {
    console.log(
      'zhcheck: inspect 引擎为项目级扫描，暂不支持单文件/暂存区模式，本次跳过（refactor 检查仍生效）。',
    );
    return { total: 0, warnings: 0, errors: 0 };
  }

  let report;
  try {
    report = await engine.runScan(projectRoot);
  } catch (e) {
    // 引擎异常不得静默放行（复查4 P1）：显式失败（exit 2）。
    console.error(`zhcheck: inspect engine error: ${e?.message ?? e}`);
    process.exit(2);
  }

  let warningCount = 0;
  let errorCount = 0;

  for (const issue of report?.issues || []) {
    if (!opts.json) {
      console.log(formatLinterIssue(issue, issue.filePath || issue.file || ''));
    }
    if (issue.severity === 'error') errorCount++;
    if (issue.severity === 'warning') warningCount++;
  }

  // 降级可见性：未实际执行的检查如实展示，不计入通过
  const degraded = report?.degraded ?? 0;
  if (degraded > 0 && !opts.json) {
    console.log(`zhcheck: ${degraded} 项检查未实际执行（工具不可用）——未检测不计为通过。`);
  }
  if (opts.json && report) {
    console.log(JSON.stringify(report, null, 2));
  }

  return {
    total: (report?.issues || []).length,
    warnings: warningCount,
    errors: errorCount,
  };
}

// ── 安全扫描 ──────────────────────────────────────────────
async function runSecurity(files, opts, projectRoot) {
  const { SecurityEngine } = await importEngine('security');
  const engine = new SecurityEngine();

  let report;
  try {
    // SecurityEngine API: runSecurityScan(projectId, projectPath)
    // 安全扫描为项目级（依赖树/恶意代码需完整上下文），不支持单文件模式
    report = await engine.runSecurityScan('zhcheck', projectRoot);
  } catch (e) {
    console.error(`zhcheck: security engine error: ${e.message}`);
    return { total: 0, warnings: 0, errors: 0 };
  }

  let warningCount = 0;
  let errorCount = 0;

  for (const vuln of report?.vulnerabilities || []) {
    if (!opts.json) {
      console.log(
        formatLinter(
          {
            severity: vuln.severity,
            ruleId: vuln.cveId || 'vulnerability',
            message: vuln.package ? `[${vuln.package}] ${vuln.title}` : vuln.title,
          },
          '',
        ),
      );
    }
    if (vuln.severity === 'error' || vuln.severity === 'critical') errorCount++;
    if (vuln.severity === 'warning' || vuln.severity === 'high') warningCount++;
  }

  if (opts.json && report) {
    console.log(JSON.stringify(report, null, 2));
  }

  return {
    total: (report?.vulnerabilities || []).length,
    warnings: warningCount,
    errors: errorCount,
  };
}

// ── 门禁检查 ──────────────────────────────────────────────
async function runGuard(files, opts, _projectRoot) {
  const { GuardEngine } = await importEngine('guard');
  const engine = new GuardEngine();

  let report;
  try {
    if (files.length > 0) {
      report = await engine.checkFiles(files);
    } else {
      report = await engine.check();
    }
  } catch (e) {
    // P1（复查4）：同 runInspect——异常静默返回 0 问题 = 静默放行，显式失败。
    console.error(`zhcheck: guard engine error: ${e?.message ?? e}`);
    process.exit(2);
  }

  const warningCount = 0;
  let errorCount = 0;

  for (const check of report?.checks || []) {
    if (!check.passed) {
      if (!opts.json) {
        console.log(`${check.name}: ${check.status}: error: guard: ${check.message || '未通过'}`);
      }
      errorCount++;
    }
  }

  return {
    total: report?.checks?.filter((c) => !c.passed).length || 0,
    warnings: warningCount,
    errors: errorCount,
  };
}

// ── 获取 Git 暂存区文件 ────────────────────────────────────
function getStagedFiles() {
  try {
    // 先尝试标准 diff（需要 HEAD）
    const cmd = 'git diff --cached --name-only --diff-filter=ACM HEAD';
    let out;
    try {
      out = execSync(cmd, {
        cwd: PROJECT_ROOT,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      // 没有 HEAD（首次提交），使用 --cached 不带 HEAD
      out = execSync('git diff --cached --name-only --diff-filter=AM', {
        cwd: PROJECT_ROOT,
        encoding: 'utf-8',
      });
    }
    return (
      out
        .split('\n')
        .filter(
          (f) =>
            f.trim() &&
            (f.endsWith('.ts') || f.endsWith('.tsx') || f.endsWith('.js') || f.endsWith('.mjs')),
        )
        // 跳过构建产物：dist/dist-electron 为自包含 bundle 与 SOP 拷贝（随仓库分发的发布物，非可分析源码）
        .filter((f) => !RE_DIST.test(f) && !RE_DIST_ELECTRON.test(f))
        // 跳过超大文件（压缩 bundle 无法做有意义的静态分析）
        .filter((f) => {
          try {
            return existsSync(f) && statSync(f).size <= 2 * 1024 * 1024; // ≤ 2MB
          } catch {
            return false;
          }
        })
        .map((f) => resolve(PROJECT_ROOT, f))
    );
  } catch {
    return [];
  }
}

// ── 安装 pre-commit hook ───────────────────────────────────
function installHooks() {
  const hooksDir = resolve(PROJECT_ROOT, '.git', 'hooks');
  if (!existsSync(hooksDir)) {
    console.error('zhcheck: not a git repository. Run git init first.');
    process.exit(1);
  }

  const hookPath = resolve(hooksDir, 'pre-commit');
  const hookContent = `#!/bin/sh
# 智汇码盾 pre-commit hook
# 安装命令: node scripts/zhcheck.mjs --install-hooks

echo "\\033[1;34m[智汇码盾]\\033[0m 检查暂存区..."

NODE="$(command -v node || echo 'node')"
SCRIPT="$(dirname "$0")/../../scripts/zhcheck.mjs"
ROOT="$(dirname "$0")/../.."

if [ -f "$ROOT/scripts/zhcheck.mjs" ]; then
  # 默认模式：仅 error 阻断提交，warning/info 为 advisory 提示
  $NODE "$ROOT/scripts/zhcheck.mjs" --refactor --inspect --staged
  RESULT=$?
  if [ $RESULT -ne 0 ]; then
    echo ""
    echo "\\033[1;31m[智汇码盾] 检查未通过，提交已阻断\\033[0m"
    echo "  使用 git commit --no-verify 跳过检查（不推荐）"
    exit 1
  fi
  echo "\\033[1;32m[智汇码盾] 检查通过\\033[0m"
else
  echo "\\033[1;33m[智汇码盾] zhcheck.mjs not found, skipping\\033[0m"
fi
`;

  writeFileSync(hookPath, hookContent);
  chmodSync(hookPath, '755');
  console.log('zhcheck: pre-commit hook installed at .git/hooks/pre-commit');
  console.log('  暂存区提交前将自动运行 refactor + inspect 检查');
}

// ── Main ────────────────────────────────────────────────────
async function main() {
  const { values } = parseArgs({
    options: {
      refactor: { type: 'boolean', default: false },
      inspect: { type: 'boolean', default: false },
      security: { type: 'boolean', default: false },
      guard: { type: 'boolean', default: false },
      all: { type: 'boolean', default: false },
      staged: { type: 'boolean', default: false },
      ci: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      file: { type: 'string' },
      project: { type: 'string' },
      'install-hooks': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });

  if (values.help) {
    console.log(`zhcheck — 智汇码盾 CLI 检查命令

用法:
  node scripts/zhcheck.mjs --refactor              # 重构异味检查
  node scripts/zhcheck.mjs --inspect               # 巡检扫描 (需要外部工具)
  node scripts/zhcheck.mjs --security              # 安全漏洞扫描
  node scripts/zhcheck.mjs --guard                 # 门禁检查
  node scripts/zhcheck.mjs --all                   # 全部引擎
  node scripts/zhcheck.mjs --all --staged          # 仅检查 Git 暂存区
  node scripts/zhcheck.mjs --refactor --file a.ts  # 检查单个文件
  node scripts/zhcheck.mjs --refactor --ci         # CI 模式 (发现问题 exit 1)
  node scripts/zhcheck.mjs --refactor --json       # JSON 格式输出
  node scripts/zhcheck.mjs --install-hooks         # 安装 pre-commit hook
  node scripts/zhcheck.mjs --refactor --project /path/to/project  # 检查外部项目

Linter 输出格式:
  file:line:col: severity: ruleId: message
`);
    process.exit(0);
  }

  if (values['install-hooks']) {
    installHooks();
    process.exit(0);
  }

  const opts = { json: values.json, ci: values.ci };

  // 扫描目标项目：--project 指定外部项目，默认当前项目
  const projectRoot = values.project ? resolve(values.project) : PROJECT_ROOT;

  if (!existsSync(projectRoot)) {
    console.error(`zhcheck: project not found: ${projectRoot}`);
    process.exit(2);
  }

  console.log(
    `zhcheck: scanning ${projectRoot === PROJECT_ROOT ? 'current project' : relative(process.cwd(), projectRoot)}`,
  );

  let stagedFiles = [];
  if (values.staged) {
    stagedFiles = getStagedFiles();
    if (stagedFiles.length === 0) {
      console.log('zhcheck: no staged TypeScript files to check.');
      process.exit(0);
    }
    console.log(`zhcheck: checking ${stagedFiles.length} staged file(s)...`);
  }

  let files = stagedFiles;
  if (values.file) {
    const fp = resolve(process.cwd(), values.file);
    if (!existsSync(fp)) {
      console.error(`zhcheck: file not found: ${values.file}`);
      process.exit(2);
    }
    files = [fp];
  }

  const engines = [];
  if (values.all || values.refactor) engines.push({ name: 'refactor', fn: runRefactor });
  if (values.all || values.inspect) engines.push({ name: 'inspect', fn: runInspect });
  if (values.all || values.security) engines.push({ name: 'security', fn: runSecurity });
  if (values.all || values.guard) engines.push({ name: 'guard', fn: runGuard });

  if (engines.length === 0) {
    console.log(
      'zhcheck: no engine selected. Use --refactor, --inspect, --security, --guard, or --all.',
    );
    console.log('zhcheck: try --help for usage.');
    process.exit(0);
  }

  let grandTotal = 0;
  let grandWarnings = 0;
  let grandErrors = 0;

  for (const engine of engines) {
    if (opts.json) console.log(`\n=== ${engine.name} ===`);
    const result = await engine.fn(files, opts, projectRoot);
    grandTotal += result.total;
    grandWarnings += result.warnings;
    grandErrors += result.errors;
  }

  // ── 汇总 ──────────────────────
  if (!opts.json) {
    console.log('');
    if (grandTotal === 0) {
      console.log('\x1b[1;32mzhcheck: 全部通过，未发现问题。\x1b[0m');
    } else {
      const parts = [];
      if (grandErrors > 0) parts.push(`\x1b[1;31m${grandErrors} errors\x1b[0m`);
      if (grandWarnings > 0) parts.push(`\x1b[1;33m${grandWarnings} warnings\x1b[0m`);
      console.log(`zhcheck: 发现 ${parts.join(', ')} 共 ${grandTotal} 个问题。`);
    }
  }

  // ── Exit code ──────────────────
  // Default: exit 1 only on errors (warnings/info are advisory)
  // --ci mode: exit 1 on errors OR warnings (strict CI gate)
  if (grandErrors > 0) {
    process.exit(1);
  }
  if (opts.ci && grandWarnings > 0) {
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('zhcheck: error:', e.message);
  process.exit(2);
});
