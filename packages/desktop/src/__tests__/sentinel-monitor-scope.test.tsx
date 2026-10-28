/**
 * 哨兵「监控范围」可见性守卫（2026-10-29）
 *
 * 用户原话：「100 分是怎么来的，都监控了哪些看不到呀？」
 *
 * ── 根因 ──────────────────────────────────────────────────────────
 * 主进程 `startMonitoringForProject` **明明返回了** started / skipped
 * （例 `['file-monitor']` / `['log-collector: no log files found']`），
 * 但渲染层 `startSentinelMonitoring` 的返回类型只声明了 started，
 * 页面又只消费 `ok` ⇒ 「三个监视器只起来一个」这种覆盖缺口在界面上完全不可见，
 * 用户只能看到 100 分，无从判断那是"监控过没问题"还是"根本没监控到"。
 *
 * ── 本测试锁两件事 ────────────────────────────────────────────────
 * 1. `describeMonitorScope` 把主进程明细翻成清单，**拿不到明细时返回 null**
 *    （`already-running` 幂等重启不给明细，绝不能退化成 3/3 或 0/3 的假象）；
 * 2. 空态页**真的渲染**出清单与"仅 N/M 个监视器在跑"提示。
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../i18n';
import { describeMonitorScope } from '../pages/sentinel-logic';
import { SentinelPage } from '../pages/SentinelPage';

const injected = vi.hoisted(() => ({
  monitorScope: null as ReturnType<typeof describeMonitorScope>,
}));

vi.mock('../pages/sentinel-logic', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../pages/sentinel-logic')>();
  return {
    ...actual,
    useSentinelPage: () => ({
      events: [],
      sorted: [],
      activeCount: 0,
      highCount: 0,
      criticalCount: 0,
      falsePositiveCount: 0,
      loading: false,
      monitoring: false,
      stopping: false,
      monitorScope: injected.monitorScope,
      refreshEvents: () => undefined,
      startMonitoring: async () => undefined,
      stopMonitoring: async () => undefined,
    }),
  };
});

vi.mock('../contexts/NotificationContext', () => ({
  useNotification: () => ({ notify: () => undefined }),
}));

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'zh-Hans-CN' });
});

/** 测试内 t 只回传键名：断言映射目标而非具体文案（文案由 i18n parity 负责） */
const keyT = (key: string): string => key;

function renderHome(): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <SentinelPage projectPath="/tmp/sentinel-demo" />
    </I18nProvider>,
  );
}

function textOf(html: string): string {
  return html
    .replace(/<svg[\s\S]*?<\/svg>/g, '')
    .replace(/<[^>]+>/g, '')
    .trim();
}

// 主进程实况：外层文档仓库只有文件监控起来，日志/进程各因一项原因被跳过
const REAL_STARTED = ['file-monitor'];
const REAL_SKIPPED = [
  'log-collector: no log files found',
  'process-monitor: no dev/start/build script found',
];

describe('describeMonitorScope — 主进程明细 → 监视器清单', () => {
  it('真阳性：三个监视器的启停与跳过原因都被翻成可展示项', () => {
    const items = describeMonitorScope(REAL_STARTED, REAL_SKIPPED, keyT);
    expect(items).not.toBeNull();
    expect(items).toHaveLength(3);
    expect(items![0]).toEqual({
      key: 'file-monitor',
      label: 'page.sentinel.scope.fileMonitor',
      running: true,
    });
    expect(items![1]).toEqual({
      key: 'log-collector',
      label: 'page.sentinel.scope.logCollector',
      running: false,
      reason: 'page.sentinel.scope.skipNoLogs',
    });
    expect(items![2]).toEqual({
      key: 'process-monitor',
      label: 'page.sentinel.scope.processMonitor',
      running: false,
      reason: 'page.sentinel.scope.skipNoScript',
    });
  });

  it('误报防护：already-running（幂等重启无明细）→ null，不许显示成 0/3 或 3/3', () => {
    expect(describeMonitorScope(['already-running'], [], keyT)).toBeNull();
    expect(describeMonitorScope([], [], keyT)).toBeNull();
  });

  it('启动说明带括号明细时按前缀命中（log-collector (3 files)）', () => {
    const items = describeMonitorScope(['file-monitor', 'log-collector (3 files)'], [], keyT);
    expect(items!.filter((i) => i.running).map((i) => i.key)).toEqual([
      'file-monitor',
      'log-collector',
    ]);
  });

  it('识别不出的跳过原因 → 仍标未启动但 reason 缺省（不编造原因）', () => {
    const items = describeMonitorScope([], ['process-monitor: not supported in http mode'], keyT);
    expect(items![2]).toEqual({
      key: 'process-monitor',
      label: 'page.sentinel.scope.processMonitor',
      running: false,
    });
  });
});

describe('哨兵空态页 — 监控范围真的可见', () => {
  it('有明细时：清单标题、三个监视器、跳过原因与覆盖不足提示都渲染出来', () => {
    injected.monitorScope = describeMonitorScope(REAL_STARTED, REAL_SKIPPED, (k, p) =>
      k === 'page.sentinel.scope.partialHint'
        ? `仅 ${String((p as Record<string, unknown>)?.started)}/${String((p as Record<string, unknown>)?.total)} 个监视器在跑`
        : ({
            'page.sentinel.scope.title': '监控范围',
            'page.sentinel.scope.fileMonitor': '文件监控',
            'page.sentinel.scope.logCollector': '日志采集',
            'page.sentinel.scope.processMonitor': '进程监控',
            'page.sentinel.scope.running': '已启动',
            'page.sentinel.scope.notStarted': '未启动',
            'page.sentinel.scope.skipNoLogs': '未发现日志文件',
            'page.sentinel.scope.skipNoScript': '未识别到 dev/start/build 脚本',
          } as Record<string, string>)[k] ?? k,
    );
    const text = textOf(renderHome());
    // 标题用「当前监控源」而非「监控范围」：空态已有一张同名功能卡（现存能力说明），
    // 这里展示的是**当前实际启停结果**，两者重名会让用户分不清"能做什么"和"正在做什么"
    expect(text).toContain('当前监控源');
    expect(text).toContain('文件监控');
    expect(text).toContain('已启动');
    expect(text).toContain('日志采集');
    expect(text).toContain('未发现日志文件');
    expect(text).toContain('进程监控');
    expect(text).toContain('未识别到 dev/start/build 脚本');
    expect(text).toContain('仅 1/3 个监视器在跑');
  });

  it('无明细时：不渲染清单（不许拿空数据冒充"都在跑"）', () => {
    injected.monitorScope = null;
    const text = textOf(renderHome());
    expect(text).not.toContain('当前监控源');
  });
});
