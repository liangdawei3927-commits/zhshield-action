/**
 * 能力清单渲染守卫 —— 「UI 宣称的能力必须真的有实现」。
 *
 * 这是「检测能力注册表」在桌面端的落地验收。锁定三件事：
 *
 * 1) **空态只渲染已实现的能力** —— 注册表里 status='planned' / 'deprecated' 的
 *    能力不得出现在页面上（宣称了却没有 = 骗用户）。
 * 2) **渲染项数与注册表一致** —— 注册表加一项，页面就得显示一项；
 *    注册表删一项，页面就得少一项。不允许页面自己另有一份清单。
 * 3) **每个能力 id 都有图标** —— 漏图标会渲染出空白块。
 *
 * 背景（2026-11-02 代码审计实测）：
 *   性能页宣称 ReDoS / 现代化 API / 定时器优化，实际只有复杂度有探测器；
 *   安全页宣称「规范检查」，全仓无实现；
 *   垃圾页宣称「重复代码」，但按《07》O1 已唯一归重构域；
 *   重构页宣称「一键应用推荐重构方案」，而所有检测器 autoFixable 均为 false。
 *
 * 这些宣称此前没有任何异常提示 —— 用户看到的能力清单与真实能力不符。
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { implementedCapabilities, unimplementedCapabilities } from '@zh/shared';
import type { DomainId } from '@zh/shared';

import { buildCapabilityFeatures } from '../components/business/capability-features';

/** 各域已接入注册表的空态页 */
const WIRED_DOMAINS: DomainId[] = ['inspect', 'security', 'garbage', 'performance', 'refactor'];

describe('能力清单渲染 — 只渲染已实现的能力', () => {
  it.each(WIRED_DOMAINS)('%s 域渲染项与注册表的已实现能力一一对应', (domain) => {
    const expected = implementedCapabilities(domain);
    const features = buildCapabilityFeatures(domain, {
      icons: Object.fromEntries(expected.map((c) => [c.id, <span key={c.id}>x</span>])),
    });

    expect(features.map((f) => f.id)).toEqual(expected.map((c) => c.id));
    expect(features).toHaveLength(expected.length);
  });

  it.each(WIRED_DOMAINS)('%s 域不得渲染未实现的能力', (domain) => {
    const unimplemented = unimplementedCapabilities(domain).map((c) => c.id);
    const features = buildCapabilityFeatures(domain, {
      icons: Object.fromEntries(
        implementedCapabilities(domain).map((c) => [c.id, <span key={c.id}>x</span>]),
      ),
    });

    for (const id of unimplemented) {
      expect(
        features.map((f) => f.id),
        `${domain} 域渲染了未实现能力 ${id}`,
      ).not.toContain(id);
    }
  });

  it('性能域宣称运行时反模式（含 ReDoS），但不得宣称现代化 API / 定时器优化（无实现）', () => {
    const ids = buildCapabilityFeatures('performance', {
      icons: Object.fromEntries(
        implementedCapabilities('performance').map((c) => [c.id, <span key={c.id}>x</span>]),
      ),
    }).map((f) => f.id);

    // ReDoS 已由原生 RedosDetectorImpl 落地；它与嵌套循环 / 同步阻塞 IO 同属
    // 「运行时反模式」，合并成一张卡（证据里仍逐条列出，见注册表测试）
    expect(ids).toContain('performance.runtime');
    expect(ids).not.toContain('performance.modern-api');
    expect(ids).not.toContain('performance.timer');
  });

  it('安全域不得宣称「规范检查」与「依赖检查」（前者无实现、后者已移交依赖域）', () => {
    const ids = buildCapabilityFeatures('security', {
      icons: Object.fromEntries(
        implementedCapabilities('security').map((c) => [c.id, <span key={c.id}>x</span>]),
      ),
    }).map((f) => f.id);

    expect(ids).not.toContain('security.standard');
    expect(ids).not.toContain('security.dependency');
  });

  it('垃圾域不得宣称「重复代码」（按 O1 已移交重构域）', () => {
    const ids = buildCapabilityFeatures('garbage', {
      icons: Object.fromEntries(
        implementedCapabilities('garbage').map((c) => [c.id, <span key={c.id}>x</span>]),
      ),
    }).map((f) => f.id);

    expect(ids).not.toContain('garbage.duplicate-code');
  });

  it('重构域宣称「一键应用」（已落地），且与自动修复生成器一一对应', () => {
    const ids = buildCapabilityFeatures('refactor', {
      icons: Object.fromEntries(
        implementedCapabilities('refactor').map((c) => [c.id, <span key={c.id}>x</span>]),
      ),
    }).map((f) => f.id);

    // 一键应用已由 @zh/refactor 生成器 + 桌面端链路落地（2026-11-03）
    expect(ids).toContain('refactor.auto-fix');
    expect(ids).toContain('refactor.duplicate-code');
    // 异味拆成函数级 / 结构级两张卡（各由不同探测器产出）
    expect(ids).toContain('refactor.smells.function');
    expect(ids).toContain('refactor.smells.structure');
  });

  it('接入空态网格的四域，卡片主标题在 4 列网格里放得下一行', () => {
    // 主标题固定单行（EntryCard md 用 truncate），超宽会被省略号截断。
    // 4 列网格在默认窗口（1440 宽）下单卡文字区约 244px，text-sm 约容纳 17 个汉字；
    // 这里按「汉字 1 单位 / ASCII 0.55 单位」折算并留出余量，取 13 单位上限。
    // 写长了不是排版问题而是文案问题：明细应挪到 summary 那行，而不是塞进标题括号。
    const widthOf = (text: string): number =>
      [...text].reduce((sum, ch) => sum + (ch.charCodeAt(0) < 128 ? 0.55 : 1), 0);

    for (const domain of ['inspect', 'garbage', 'performance', 'refactor'] as const) {
      const features = buildCapabilityFeatures(domain, {
        icons: Object.fromEntries(
          implementedCapabilities(domain).map((c) => [c.id, <span key={c.id}>x</span>]),
        ),
      });
      for (const f of features) {
        expect(
          widthOf(f.title),
          `${domain}/${f.id} 的标题「${f.title}」过宽，会在卡片里被截断；明细请写进 summary`,
        ).toBeLessThanOrEqual(13);
      }
    }
  });

  it('接入空态网格的四域，每域恰好 4 张能力卡（底部版式全站统一）', () => {
    // 版式统一是产品要求（2026-11-14）：底部卡片固定 4 列，某页多一张会掉到第二行、
    // 少一张会空出半格。注册表能力增减时，这里必须同步调整卡片口径 ——
    // 要么合并（同属一类的实现证据并成一张卡），要么拆开（不同探测器产出的分开）。
    for (const domain of ['inspect', 'garbage', 'performance', 'refactor'] as const) {
      const features = buildCapabilityFeatures(domain, {
        icons: Object.fromEntries(
          implementedCapabilities(domain).map((c) => [c.id, <span key={c.id}>x</span>]),
        ),
      });
      expect(features.map((f) => f.id), `${domain} 域的底部卡片数不是 4`).toHaveLength(4);
    }
  });
});

describe('能力清单渲染 — 展示质量', () => {
  it.each(WIRED_DOMAINS)('%s 域每项能力都有标题与说明（不得为空串）', (domain) => {
    const features = buildCapabilityFeatures(domain, {
      icons: Object.fromEntries(
        implementedCapabilities(domain).map((c) => [c.id, <span key={c.id}>x</span>]),
      ),
    });

    for (const f of features) {
      expect(f.title, `${domain}/${f.id} 缺标题`).toBeTruthy();
      expect(f.desc, `${domain}/${f.id} 缺说明`).toBeTruthy();
    }
  });

  it.each(WIRED_DOMAINS)('%s 域渲染结果不含 undefined / 空图标占位', (domain) => {
    const features = buildCapabilityFeatures(domain, {
      icons: Object.fromEntries(
        implementedCapabilities(domain).map((c) => [c.id, <span key={c.id}>x</span>]),
      ),
    });

    for (const f of features) {
      expect(f.icon, `${domain}/${f.id} 缺图标`).toBeTruthy();
    }

    // 渲染一遍，确保没有 undefined 泄漏到 DOM
    const html = renderToStaticMarkup(
      <ul>
        {features.map((f) => (
          <li key={f.id}>
            {f.title} — {f.desc}
          </li>
        ))}
      </ul>,
    );
    expect(html).not.toContain('undefined');
  });
});
