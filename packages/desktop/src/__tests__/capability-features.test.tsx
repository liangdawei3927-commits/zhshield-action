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

import {
  buildCapabilityFeatures,
  buildPlannedCapabilities,
} from '../components/business/capability-features';

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

  it('性能域宣称 ReDoS（已实现），但不得宣称现代化 API / 定时器优化（无实现）', () => {
    const ids = buildCapabilityFeatures('performance', {
      icons: Object.fromEntries(
        implementedCapabilities('performance').map((c) => [c.id, <span key={c.id}>x</span>]),
      ),
    }).map((f) => f.id);

    // ReDoS 已由原生 RedosDetectorImpl 落地，可在性能页宣称
    expect(ids).toContain('performance.redos');
    expect(ids).not.toContain('performance.modern-api');
    expect(ids).not.toContain('performance.timer');
    expect(ids).toContain('performance.runtime.nested-loop');
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
    expect(ids).toContain('refactor.smells');
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

describe('能力清单渲染 — 规划中清单（未实现，仅告知，不宣称）', () => {
  it.each(WIRED_DOMAINS)('%s 域 planned 清单与注册表未实现能力一一对应', (domain) => {
    const expected = unimplementedCapabilities(domain).map((c) => c.id);
    const planned = buildPlannedCapabilities(domain).map((p) => p.id);
    expect(planned).toEqual(expected);
  });

  it.each(WIRED_DOMAINS)('%s 域 planned 与已实现能力不重叠（不重复宣称）', (domain) => {
    const impl = new Set(implementedCapabilities(domain).map((c) => c.id));
    for (const p of buildPlannedCapabilities(domain)) {
      expect(impl.has(p.id), `${domain}/${p.id} 同时出现在已实现与规划中`).toBe(false);
    }
  });

  it.each(WIRED_DOMAINS)('%s 域 planned 项标题与说明均非空', (domain) => {
    for (const p of buildPlannedCapabilities(domain)) {
      expect(p.title, `${domain}/${p.id} 缺标题`).toBeTruthy();
      expect(p.desc, `${domain}/${p.id} 缺说明`).toBeTruthy();
    }
  });

  it('性能域 planned 不再含 ReDoS，仍含现代化 API / 定时器', () => {
    const ids = buildPlannedCapabilities('performance').map((p) => p.id);
    expect(ids).not.toContain('performance.redos');
    expect(ids).toContain('performance.modern-api');
    expect(ids).toContain('performance.timer');
  });

  it('安全域 planned 区分「规范检查」(planned) 与「依赖检查」(deprecated 已移交)', () => {
    const byId = Object.fromEntries(buildPlannedCapabilities('security').map((p) => [p.id, p]));
    expect(byId['security.standard']?.status).toBe('planned');
    expect(byId['security.dependency']?.status).toBe('deprecated');
  });
});
