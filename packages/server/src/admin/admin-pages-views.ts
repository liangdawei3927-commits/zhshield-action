import type { RuleContentRow, ToolPackageRow } from '@zh/db';
import { escapeHtml, pageShell } from './admin-pages-view';

const DOMAINS = ['guard', 'inspect', 'security', 'sentinel', 'evolve', 'refactor'];
const ACTIONS = ['scan', 'block', 'score', 'alert', 'suggest', 'calibrate'];
const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info', 'error'];
const STATUSES = ['draft', 'trial', 'active', 'deprecated', 'disabled'];

function options(values: string[], selected: string): string {
  return values
    .map((v) => `<option value="${v}"${v === selected ? ' selected' : ''}>${v}</option>`)
    .join('');
}

function safeJsonArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function historyRows(
  versions: Array<{ version: string; releasedAt: string }>,
  rollbackUrl: (version: string) => string,
): string {
  return versions
    .map(
      (v) => `<tr>
<td>${escapeHtml(v.version)}</td>
<td>${escapeHtml(v.releasedAt)}</td>
<td>
  <form method="post" action="${rollbackUrl(v.version)}" class="inline">
    <input type="hidden" name="version" value="${escapeHtml(v.version)}">
    <button type="submit">回滚</button>
  </form>
</td>
</tr>`,
    )
    .join('\n');
}

/** 规则列表页 */
export function ruleListPage(rules: RuleContentRow[]): string {
  const rows = rules
    .map((r) => {
      const id = encodeURIComponent(r.rule_id);
      return `<tr>
<td>${escapeHtml(r.rule_id)}</td>
<td>${escapeHtml(r.name)}</td>
<td>${escapeHtml(r.domain)}</td>
<td>${escapeHtml(r.severity)}</td>
<td>${escapeHtml(r.status)}</td>
<td>${escapeHtml(r.version)}</td>
<td>
  <a href="/admin-ui/rules/${id}">编辑</a>
  <form method="post" action="/admin-ui/rules/${id}/publish" class="inline"><button type="submit">发布</button></form>
  <form method="post" action="/admin-ui/rules/${id}/delete" class="inline"><button type="submit">删除</button></form>
</td>
</tr>`;
    })
    .join('\n');
  return pageShell(
    '规则列表',
    `<h1>规则列表</h1>
<table>
<thead><tr><th>ID</th><th>名称</th><th>域</th><th>严重级</th><th>状态</th><th>版本</th><th>操作</th></tr></thead>
<tbody>${rows}</tbody>
</table>`,
  );
}

/** 规则编辑页：表单 + 历史版本 + 操作 */
export function ruleEditPage(
  rule: RuleContentRow,
  versions: Array<{ version: string; releasedAt: string }>,
  yamlText: string,
  error?: string,
): string {
  const id = encodeURIComponent(rule.rule_id);
  const msg = error ? `<p class="msg">${escapeHtml(error)}</p>` : '';
  const tags = safeJsonArray(rule.tags).join(', ');
  const history = historyRows(versions, () => `/admin-ui/rules/${id}/rollback`);
  return pageShell(
    `编辑规则 ${rule.rule_id}`,
    `<h1>编辑规则</h1>
${msg}
<form method="post" action="/admin-ui/rules/${id}/save">
  <label for="name">名称</label>
  <input type="text" id="name" name="name" value="${escapeHtml(rule.name)}" required>
  <label for="domain">域</label>
  <select id="domain" name="domain">${options(DOMAINS, rule.domain)}</select>
  <label for="action">动作</label>
  <select id="action" name="action">${options(ACTIONS, rule.action)}</select>
  <label for="severity">严重级</label>
  <select id="severity" name="severity">${options(SEVERITIES, rule.severity)}</select>
  <label for="tags">标签（逗号分隔）</label>
  <input type="text" id="tags" name="tags" value="${escapeHtml(tags)}">
  <label for="description">描述</label>
  <input type="text" id="description" name="description" value="${escapeHtml(rule.description ?? '')}">
  <label for="content">规则正文（YAML）</label>
  <textarea id="content" name="content">${escapeHtml(yamlText)}</textarea>
  <button type="submit" style="margin-top:12px">保存</button>
</form>
<h2>历史版本</h2>
<table>
<thead><tr><th>版本</th><th>发布时间</th><th>操作</th></tr></thead>
<tbody>${history}</tbody>
</table>
<h2>操作</h2>
<form method="post" action="/admin-ui/rules/${id}/publish" class="inline"><button type="submit">发布</button></form>
<form method="post" action="/admin-ui/rules/${id}/status" class="inline">
  <select name="status">${options(STATUSES, rule.status)}</select>
  <button type="submit">改状态</button>
</form>
<form method="post" action="/admin-ui/rules/${id}/delete" class="inline"><button type="submit">软删</button></form>
<p class="muted">当前状态: ${escapeHtml(rule.status)} · 版本: ${escapeHtml(rule.version)} · content_sha: ${escapeHtml(rule.content_sha)}</p>`,
  );
}

/** 工具列表页 */
export function toolListPage(tools: ToolPackageRow[]): string {
  const rows = tools
    .map((t) => {
      const id = encodeURIComponent(t.tool_id);
      return `<tr>
<td>${escapeHtml(t.tool_id)}</td>
<td>${escapeHtml(t.status)}</td>
<td>${escapeHtml(t.version)}</td>
<td>
  <a href="/admin-ui/tools/${id}">详情</a>
  <form method="post" action="/admin-ui/tools/${id}/publish" class="inline"><button type="submit">发布</button></form>
  <form method="post" action="/admin-ui/tools/${id}/delete" class="inline"><button type="submit">删除</button></form>
</td>
</tr>`;
    })
    .join('\n');
  return pageShell(
    '工具列表',
    `<h1>工具列表</h1>
<table>
<thead><tr><th>工具 ID</th><th>状态</th><th>版本</th><th>操作</th></tr></thead>
<tbody>${rows}</tbody>
</table>`,
  );
}

/** 工具详情页：版本历史 + 回滚 */
export function toolDetailPage(
  tool: ToolPackageRow,
  versions: Array<{ version: string; releasedAt: string }>,
): string {
  const id = encodeURIComponent(tool.tool_id);
  const history = historyRows(versions, () => `/admin-ui/tools/${id}/rollback`);
  return pageShell(
    `工具 ${tool.tool_id}`,
    `<h1>工具 ${escapeHtml(tool.tool_id)}</h1>
<p class="muted">状态: ${escapeHtml(tool.status)} · 版本: ${escapeHtml(tool.version)} · sha256: ${escapeHtml(tool.sha256)}</p>
<p>描述: ${escapeHtml(tool.description ?? '')}</p>
<h2>版本历史</h2>
<table>
<thead><tr><th>版本</th><th>发布时间</th><th>操作</th></tr></thead>
<tbody>${history}</tbody>
</table>
<h2>操作</h2>
<form method="post" action="/admin-ui/tools/${id}/publish" class="inline"><button type="submit">发布</button></form>
<form method="post" action="/admin-ui/tools/${id}/delete" class="inline"><button type="submit">软删</button></form>`,
  );
}