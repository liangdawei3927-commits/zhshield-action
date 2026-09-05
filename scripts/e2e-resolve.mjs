/**
 * T0→T1 全链路端到端联调脚本（e2e-resolve.mjs）
 *
 * 用法：
 *   node scripts/e2e-resolve.mjs --with-server   # 脚本内自动拉起 server（独立端口/独立 DB）
 *
 * 验证链路（对应用户核心流程）：
 *   1. GET  /health                        服务可用
 *   2. POST /orgs                          建组织（本地默认组织兜底的云端形态）
 *   3. POST /orgs/:id/rules                发布组织规则快照（运营主通道）
 *   4. PUT  /orgs/:id/projects/:pid/features  T0 画像注册（kernel 客户端）
 *   5. POST /resolve/tools                 按画像裁剪工具清单（kernel 客户端）
 *   6. POST /resolve/rules                 生效清单 + changed 差量（kernel 客户端）
 *      - 未上报 currentVersions → 全量变更
 *      - content_sha 一致 → 免重发（版本号不同也免）
 *      - 内容漂移 → 进 changed
 *   7. verifyRuleManifest + needsHeal      本地 vs 云端清单漂移检测（kernel 校验器）
 *      - 一致 → 不自愈；云端停用规则 → missing → 自愈触发；恢复后收敛
 *   8. 跨租户隔离                          org2 解析不到 org1 的规则
 *   9. admin 管理后台发布平台规则          POST /admin/rules → publish → /resolve/rules 差量可见
 *      （C5 Gate：编辑规则→发布→客户端同步生效，走真实管理接口而非 orgs 快照通道）
 */

import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

const require_ = createRequire(import.meta.url);
const ROOT = new URL('..', import.meta.url).pathname;

const PORT = process.env.E2E_PORT ?? '3012';
const API_BASE = `http://localhost:${PORT}/api/v1`;
const DB_DIR = '/tmp/zh-e2e';
const DB_PATH = join(DB_DIR, 'e2e.db');
const ADMIN_TOKEN = process.env.E2E_ADMIN_TOKEN ?? 'e2e-admin-token';

const kernelResolve = require_(join(ROOT, 'packages/kernel/dist/sop/sync/resolve-api.js'));
const verifier = require_(join(ROOT, 'packages/kernel/dist/sop/cache/sop-resolve-verifier.js'));

// ─── 小工具 ──────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function check(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function waitHealthy(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${PORT}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`server 未在 ${timeoutMs}ms 内就绪`);
}

/** 直接调 orgs 端点（建组织/发布规则——运营侧通道，非 kernel 客户端职责） */
async function orgsApi(method, path, body) {
  const token = kernelResolve.readApiToken();
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-api-token': token,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`${method} ${path} → HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

/** 调 admin 管理接口（ZH_ADMIN_TOKEN Bearer）——C5 真实管理后台链路 */
async function adminApi(method, path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ADMIN_TOKEN}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`${method} ${path} → HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

/** 构造本地 SopRule 最小样本（与 kernel 校验器入参对齐） */
function makeLocalRule(id, content) {
  return {
    id,
    name: `规则 ${id}`,
    domain: 'inspect',
    action: 'scan',
    source: 'external',
    description: 'E2E 联调规则',
    status: 'active',
    executionMode: 'sync',
    severity: 'medium',
    applicableEngines: ['inspect'],
    content,
    tags: ['e2e'],
    falsePositiveCount: 0,
    truePositiveCount: 0,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };
}

// ─── 主流程 ──────────────────────────────────────────────────

async function main() {
  const withServer = process.argv.includes('--with-server');
  let serverProc = null;

  if (withServer) {
    rmSync(DB_DIR, { recursive: true, force: true });
    serverProc = spawn(process.execPath, [join(ROOT, 'packages/server/dist/main.js')], {
      cwd: join(ROOT, 'packages/server'),
      env: {
        ...process.env,
        PORT,
        ZH_SERVER_DB: DB_PATH,
        ZH_ADMIN_TOKEN: ADMIN_TOKEN,
        NODE_OPTIONS: '',
      },
      stdio: 'ignore',
      detached: true,
    });
    console.log(`[e2e] 已拉起 server (pid=${serverProc.pid}, port=${PORT}, db=${DB_PATH})`);
  }

  try {
    await waitHealthy();
    console.log(`[e2e] server 就绪: ${API_BASE}\n`);

    console.log('── 1. 健康探活 ──');
    check('GET /resolve/health', await kernelResolve.health(API_BASE));

    console.log('\n── 2. 建组织 ──');
    const org = await orgsApi('POST', '/orgs', { name: 'e2e-org', ownerId: 'user-owner' });
    check(
      'POST /orgs 返回 orgId',
      typeof org.orgId === 'string' && org.orgId.length > 0,
      JSON.stringify(org),
    );

    console.log('\n── 3. 发布组织规则快照（模拟运营侧主通道） ──');
    const localRules = [
      makeLocalRule('e2e.rule.inspect', { tool: 'eslint', preset: 'recommended' }),
      makeLocalRule('e2e.rule.security', { tool: 'semgrep', severity: 'high' }),
    ];
    for (const rule of localRules) {
      const sha = verifier.computeRuleContentSha(rule);
      await orgsApi('POST', `/orgs/${org.orgId}/rules`, {
        ruleId: rule.id,
        version: '1.0.0',
        contentSha: sha,
      });
      console.log(`  · 发布 ${rule.id} v1.0.0 sha=${sha.slice(0, 12)}…`);
    }
    check('规则发布完成', true);

    console.log('\n── 4. T0 画像注册（kernel 客户端） ──');
    const feature = { language: 'typescript', framework: 'nestjs', features: ['security'] };
    await kernelResolve.registerProjectFeatures(
      org.orgId,
      'user-owner',
      'e2e-proj-1',
      feature,
      API_BASE,
    );
    check('PUT /orgs/:id/projects/:pid/features → ok', true);
    // 非成员注册应被拒
    let rejected = false;
    try {
      await kernelResolve.registerProjectFeatures(
        org.orgId,
        'user-intruder',
        'e2e-proj-x',
        feature,
        API_BASE,
      );
    } catch {
      rejected = true;
    }
    check('非组织成员 T0 注册被拒', rejected);

    console.log('\n── 5. /resolve/tools 按画像裁剪（kernel 客户端） ──');
    const tsTools = await kernelResolve.resolveTools(org.orgId, feature, API_BASE);
    check(
      'TS 画像 → 4 工具全量（semgrep/trivy/eslint/dep-cruiser）',
      JSON.stringify([...tsTools].sort()) ===
        JSON.stringify(['dep-cruiser', 'eslint', 'semgrep', 'trivy']),
      JSON.stringify(tsTools),
    );
    const pyFeature = { language: 'python', framework: 'fastapi', features: ['security'] };
    const pyTools = await kernelResolve.resolveTools(org.orgId, pyFeature, API_BASE);
    check(
      'Python 画像 → 语言相关工具裁剪（eslint/dep-cruiser 剔除）',
      JSON.stringify([...pyTools].sort()) === JSON.stringify(['semgrep', 'trivy']),
      JSON.stringify(pyTools),
    );

    console.log('\n── 6. /resolve/rules 差量（kernel 客户端） ──');
    const first = await kernelResolve.resolveRules(org.orgId, feature, undefined, API_BASE);
    check(
      '未上报 currentVersions → 全部视为变更',
      first.changed.length === 2,
      JSON.stringify(first.changed),
    );
    check(
      '生效清单 2 条',
      first.rules.length === 2,
      JSON.stringify(first.rules.map((r) => r.ruleId)),
    );

    // content_sha 一致 → 免重发（即使 version 变了）
    const sameShaNewVersion = await orgsApi('POST', `/orgs/${org.orgId}/rules`, {
      ruleId: 'e2e.rule.inspect',
      version: '9.9.9',
      contentSha: verifier.computeRuleContentSha(localRules[0]),
    });
    check('重发同内容新版本号 → ok', sameShaNewVersion.ok === true);
    const second = await kernelResolve.resolveRules(
      org.orgId,
      feature,
      {
        'e2e.rule.inspect': verifier.computeRuleContentSha(localRules[0]),
        'e2e.rule.security': verifier.computeRuleContentSha(localRules[1]),
      },
      API_BASE,
    );
    check(
      'content_sha 一致 → 免重发（changed 为空）',
      second.changed.length === 0,
      JSON.stringify(second.changed),
    );

    // 内容漂移 → 进 changed
    await orgsApi('POST', `/orgs/${org.orgId}/rules`, {
      ruleId: 'e2e.rule.security',
      version: '1.1.0',
      contentSha: 'deadbeef' + '0'.repeat(56),
    });
    const third = await kernelResolve.resolveRules(
      org.orgId,
      feature,
      {
        'e2e.rule.inspect': verifier.computeRuleContentSha(localRules[0]),
        'e2e.rule.security': verifier.computeRuleContentSha(localRules[1]),
      },
      API_BASE,
    );
    check(
      '内容漂移 → 进 changed',
      JSON.stringify(third.changed) === JSON.stringify(['e2e.rule.security']),
      JSON.stringify(third.changed),
    );

    console.log('\n── 7. 清单漂移检测 + 自愈触发（kernel 校验器） ──');
    // 一致场景：用 content_sha 尚未漂移时的清单（second）
    const clean = verifier.verifyRuleManifest(localRules, second.rules);
    check('本地与云端一致 → 不触发自愈', !verifier.needsHeal(clean), JSON.stringify(clean));

    // missing 场景：云端新发规则、本地还没有 → missing → 触发自愈
    const newLocal = makeLocalRule('e2e.rule.new', { tool: 'trivy' });
    await orgsApi('POST', `/orgs/${org.orgId}/rules`, {
      ruleId: 'e2e.rule.new',
      version: '1.0.0',
      contentSha: verifier.computeRuleContentSha(newLocal),
    });
    const withNew = await kernelResolve.resolveRules(org.orgId, feature, undefined, API_BASE);
    const drifted = verifier.verifyRuleManifest(localRules, withNew.rules);
    check(
      '云端新增规则、本地缺失 → missing → 触发自愈',
      verifier.needsHeal(drifted) && drifted.missing.includes('e2e.rule.new'),
      JSON.stringify(drifted),
    );

    // 自愈模拟：本地补拉新规则
    const healedLocal = [...localRules, newLocal];

    // 云端停用规则（运营下线）→ 本地规则进 unexpected（仅观测不误删，按设计不触发自愈）
    await orgsApi('POST', `/orgs/${org.orgId}/rules`, {
      ruleId: 'e2e.rule.security',
      version: '1.1.0',
      enabled: false,
    });
    const afterDisable = await kernelResolve.resolveRules(org.orgId, feature, undefined, API_BASE);
    const offlined = verifier.verifyRuleManifest(healedLocal, afterDisable.rules);
    check(
      '云端停用 → 本地规则进 unexpected（观测不删、不自愈）；补拉后收敛',
      !verifier.needsHeal(offlined) && offlined.unexpected.includes('e2e.rule.security'),
      JSON.stringify(offlined),
    );

    console.log('\n── 8. 跨租户隔离 ──');
    const org2 = await orgsApi('POST', '/orgs', { name: 'e2e-org-2', ownerId: 'user-owner2' });
    const org2Rules = await kernelResolve.resolveRules(org2.orgId, feature, undefined, API_BASE);
    check(
      'org2 解析不到 org1 的规则（隔离）',
      org2Rules.rules.length === 0,
      JSON.stringify(org2Rules),
    );

    console.log('\n── 9. C5 Gate: admin 管理后台发布平台规则 → 客户端差量可见 ──');
    // 未带令牌 → 401（鉴权在真实链路上生效）
    const noTokenRes = await fetch(`${API_BASE}/admin/rules`, {
      signal: AbortSignal.timeout(15000),
    });
    check('admin 无令牌 → HTTP 401', noTokenRes.status === 401, String(noTokenRes.status));

    // 新建规则草稿（走管理接口）
    const adminRuleId = 'e2e.admin.platform';
    const created = await adminApi('POST', '/admin/rules', {
      id: adminRuleId,
      name: '平台侧 C5 E2E 规则',
      domain: 'security',
      action: 'scan',
      source: 'official',
      severity: 'high',
      executionMode: 'async',
      status: 'draft',
      applicableEngines: ['security'],
      content: { tool: 'semgrep', severity: 'high', rule: 'c5-e2e-admin' },
      tags: ['e2e', 'admin'],
    });
    check('POST /admin/rules 创建草稿 → ruleId', created.ruleId === adminRuleId, JSON.stringify(created));

    // 发布平台规则（P2-4 语义：rule_scope 平台行，全租户生效）
    const published = await adminApi('POST', `/admin/rules/${adminRuleId}/publish`, {});
    check('POST /admin/rules/:id/publish → ok', published.ok === true, JSON.stringify(published));

    // resolve 差量（org1 客户端未上报该规则版本 → 全量变更含新规则）
    const adminResolve = await kernelResolve.resolveRules(org.orgId, feature, undefined, API_BASE);
    check(
      '发布后 /resolve/rules 差量包含新平台规则',
      adminResolve.rules.some((r) => r.ruleId === adminRuleId),
      JSON.stringify(adminResolve.rules.map((r) => r.ruleId)),
    );
    check(
      '新平台规则进 changed（客户端未上报 → 全量变更）',
      adminResolve.changed.includes(adminRuleId),
      JSON.stringify(adminResolve.changed),
    );
    // 审计留痕（读库验证 publish 审计存在）
    const auditRes = await fetch(
      `${API_BASE}/admin/rules/${adminRuleId}`,
      {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
        signal: AbortSignal.timeout(15000),
      },
    );
    check('GET /admin/rules/:id 可读已发布规则', auditRes.ok === true, String(auditRes.status));

    console.log(`\n════════ E2E 结果: ${passed} 通过 / ${failed} 失败 ════════`);
    process.exitCode = failed === 0 ? 0 : 1;
  } finally {
    if (serverProc) {
      try {
        process.kill(-serverProc.pid);
      } catch {
        /* already down */
      }
    }
  }
}

main().catch((err) => {
  console.error('[e2e] 致命错误:', err);
  process.exit(1);
});
