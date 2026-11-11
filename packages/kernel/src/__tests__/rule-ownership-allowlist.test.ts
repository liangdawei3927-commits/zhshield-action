import { describe, it, expect } from 'vitest';
import * as path from 'node:path';

import { resolveOwnerId } from '@zh/shared';
import { SopRegistry } from '../sop/_meta/sop-registry';
import { SopLoader } from '../sop/_meta/sop-loader';
import type { SopRule } from '../sop/_meta/sop-types';

/**
 * 归属白名单门禁（A1 / C3 的回归护栏）。
 *
 * 为什么需要它：归属注册表允许「token 压过域前缀」，于是新增一条规则只要
 * id 里带 `cve` / `duplication` 之类的 token，就会**静默**被让位到别的域。
 * 2026-11-11 的让位修正（pr: 让位判据收敛到求值入口）是靠人工审计那 11 条跨域
 * 规则发现的 —— 不能再靠人工。这里把「内置规则集里到底有哪些跨域规则」锁成
 * 白名单：新增一条未复核的跨域规则 → 立刻红。
 *
 * 白名单不是免死金牌：每条都要写裁决依据；规则被删掉后必须同步删除条目
 * （否则「死条目」用例会红）。云同步规则不在本用例范围（inner loop 只锁内置集）。
 */
const PRESETS_DIR = path.resolve(__dirname, '../sop/presets/sop-templates');

/** 已人工复核的跨域规则（规则 id → 裁决依据） */
const REVIEWED_CROSS_DOMAIN: Readonly<Record<string, string>> = {
  'guard.block.external.sensitive-info':
    'O3 密钥唯一归 security；门禁在结论模式下消费 security 结论做阻断（策略闸，不重扫）',
};

async function loadBuiltInRules(): Promise<SopRule[]> {
  const registry = new SopRegistry();
  const loader = new SopLoader(registry, { rulesDir: PRESETS_DIR });
  await loader.loadFromFileSystem();
  return registry.getAll();
}

/** 内置集里 owner ≠ 本域 的规则（含域与 Owner 对照，便于定位） */
async function crossDomainRules(): Promise<Array<{ id: string; domain: string; owner: string }>> {
  const rules = await loadBuiltInRules();
  return rules
    .map((rule) => ({ rule, owner: resolveOwnerId(rule.id) }))
    .filter((entry) => entry.owner !== null && entry.owner !== entry.rule.domain)
    .map((entry) => ({
      id: entry.rule.id,
      domain: entry.rule.domain,
      owner: String(entry.owner),
    }));
}

describe('归属白名单 — 内置规则集的跨域让位必须人工复核', () => {
  it('未登记复核依据的跨域规则 → 红（含域与 Owner 的对照）', async () => {
    const crossDomain = await crossDomainRules();
    const unreviewed = crossDomain.filter((entry) => !(entry.id in REVIEWED_CROSS_DOMAIN));

    expect(
      unreviewed.map((entry) => `${entry.id}（${entry.domain} → ${entry.owner}）`),
      '这些规则会把检测让位给别的域，但没有登记复核依据；先在 REVIEWED_CROSS_DOMAIN 里写明裁决原因',
    ).toEqual([]);
    // 有效性自检：确实存在跨域规则，否则本门禁可能永远不生效（空集静默通过）
    expect(crossDomain.length).toBeGreaterThan(0);
  });

  it('白名单与实际跨域集合完全一致（多登记 / 少登记都红）', async () => {
    const crossDomain = await crossDomainRules();
    const actual = new Set(crossDomain.map((entry) => entry.id));
    expect(new Set(Object.keys(REVIEWED_CROSS_DOMAIN))).toEqual(actual);
  });

  it('白名单没有死条目：登记过的规则必须仍在规则集里', async () => {
    const ids = new Set((await loadBuiltInRules()).map((rule) => rule.id));
    const dead = Object.keys(REVIEWED_CROSS_DOMAIN).filter((id) => !ids.has(id));
    expect(dead, '白名单里的规则已不存在，请删除或更新登记').toEqual([]);
  });
});
