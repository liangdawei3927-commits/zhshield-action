// fixture: 单文件 8 个小组件，文件有效行数 > 150，但每个组件均 < 150 行
// 回归目标：oversized-component 必须按组件粒度统计（旧实现用文件级 linesOfCode 冒充单组件行数）
interface GridRow {
  id: number;
  label: string;
  status: 'ok' | 'warn' | 'fail';
  owner: string;
  updatedAt: string;
}

function RowCell({ row }: { row: GridRow }): JSX.Element {
  const badge = row.status === 'ok' ? '🟢' : row.status === 'warn' ? '🟡' : '🔴';
  return (
    <tr>
      <td>{row.id}</td>
      <td>{row.label}</td>
      <td>{badge}</td>
      <td>{row.owner}</td>
      <td>{row.updatedAt}</td>
    </tr>
  );
}

function ReportsTable({ rows }: { rows: GridRow[] }): JSX.Element {
  return (
    <table>
      <thead>
        <tr>
          <th>ID</th>
          <th>目标</th>
          <th>状态</th>
          <th>负责人</th>
          <th>更新时间</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <RowCell key={row.id} row={row} />
        ))}
      </tbody>
      <tfoot>
        <tr>
          <td colSpan={5}>共 {rows.length} 条记录</td>
        </tr>
      </tfoot>
    </table>
  );
}

function ReportsSidebar({ rows }: { rows: GridRow[] }): JSX.Element {
  const okCount = rows.filter((r) => r.status === 'ok').length;
  const warnCount = rows.filter((r) => r.status === 'warn').length;
  const failCount = rows.filter((r) => r.status === 'fail').length;
  const total = rows.length;
  return (
    <aside>
      <section>
        <h4>通过</h4>
        <p>{okCount} 项</p>
      </section>
      <section>
        <h4>告警</h4>
        <p>{warnCount} 项</p>
      </section>
      <section>
        <h4>失败</h4>
        <p>{failCount} 项</p>
      </section>
      <section>
        <h4>合计</h4>
        <p>{total} 项</p>
      </section>
      <footer>通过率 {total === 0 ? '—' : `${Math.round((okCount / total) * 100)}%`}</footer>
    </aside>
  );
}

function ReportsHeader({ title, onExport }: { title: string; onExport: () => void }): JSX.Element {
  return (
    <header>
      <h2>{title}</h2>
      <button onClick={onExport}>导出报告</button>
      <span className="hint">仅展示最近一次扫描结果</span>
    </header>
  );
}

function FiltersPanel({ onApply }: { onApply: (f: string) => void }): JSX.Element {
  const filters = ['全部', '通过', '告警', '失败'];
  const severities = ['low', 'medium', 'high', 'critical'];
  return (
    <div className="filters">
      {filters.map((f) => (
        <button key={f} onClick={() => onApply(f)}>
          {f}
        </button>
      ))}
      <select>
        {severities.map((s) => (
          <option key={s}>{s}</option>
        ))}
      </select>
      <input placeholder="按目标搜索" />
    </div>
  );
}

function ActionBar({ onRefresh, onClear }: { onRefresh: () => void; onClear: () => void }): JSX.Element {
  return (
    <div className="actions">
      <button onClick={onRefresh}>刷新</button>
      <button onClick={onClear}>清空筛选</button>
    </div>
  );
}

function PaginationBar({ page, total }: { page: number; total: number }): JSX.Element {
  const pages = Math.max(1, Math.ceil(total / 20));
  const prevDisabled = page <= 1;
  const nextDisabled = page >= pages;
  return (
    <nav>
      <button disabled={prevDisabled}>上一页</button>
      <span>
        {page} / {pages}
      </span>
      <button disabled={nextDisabled}>下一页</button>
    </nav>
  );
}

function StatusLegend(): JSX.Element {
  return (
    <ul className="legend">
      <li>🟢 通过</li>
      <li>🟡 告警</li>
      <li>🔴 失败</li>
    </ul>
  );
}

function EmptyState({ onReset }: { onReset: () => void }): JSX.Element {
  return (
    <div className="empty-state">
      <h3>暂无数据</h3>
      <p>调整筛选条件后重试，或清空全部条件查看完整列表。</p>
      <button onClick={onReset}>清空筛选</button>
    </div>
  );
}

function SummaryCards({ rows }: { rows: GridRow[] }): JSX.Element {
  const flowRate = Math.round(rows.length === 0 ? 0 : (60 * 1000) / rows.length);
  const critical = rows.filter((r) => r.status === 'fail').length;
  const pending = rows.filter((r) => r.status === 'warn').length;
  return (
    <div className="summary">
      <article>
        <h4>吞吐</h4>
        <p>{flowRate} 条/分</p>
      </article>
      <article>
        <h4>严重</h4>
        <p>{critical} 项</p>
      </article>
      <article>
        <h4>待处理</h4>
        <p>{pending} 项</p>
      </article>
    </div>
  );
}