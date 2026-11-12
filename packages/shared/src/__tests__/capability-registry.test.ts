import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  CAPABILITY_REGISTRY,
  CAPABILITIES_BY_DOMAIN,
  findCapabilitiesWithoutEvidence,
  implementedCapabilities,
  unimplementedCapabilities,
} from '../capability-registry';

/**
 * 检测能力注册表的验收用例。
 *
 * 锁定的不变量：**「宣称已实现」的能力必须指得出实现证据**。
 *
 * 这条不变量的意义（2026-11-02 实测驱动）：
 *   性能页空态宣称「ReDoS 检测」「现代化 API」「定时器优化」，
 *   但 `redos.yml` 是死资产（引用它的规则文件不存在）、后两项无探测器；
 *   安全页空态宣称「规范检查」，全仓无实现。
 *   用户看到的能力清单与真实能力不符，且**没有任何异常提示**。
 *
 * 判据形式采用「声明 → 证据」双向核对，不是黑名单：
 * 新增能力若忘了写实现证据，会在这里变红。
 */

// shared/src/__tests__ → 上溯 4 级 = 仓库根
// （__tests__ → src → shared → packages → 仓库根）
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

/** 收集仓库里真实存在的标识符（SOP 规则 id / 探测器 ruleId / 坏味道类型 / 检测器常量） */
function collectEvidence(): Set<string> {
  const evidence = new Set<string>();
  const skipDirs = new Set(['node_modules', 'dist', 'dist-electron', 'build', 'coverage']);

  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (skipDirs.has(entry.name) || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.name.endsWith('.yml') || entry.name.endsWith('.yaml')) {
        const text = fs.readFileSync(full, 'utf-8');
        // 规则文件的 id 在 metadata 段，形如 `  id: "security.scan.semgrep.xss"`
        for (const m of text.matchAll(/(?:^|\n)\s*id:\s*["']([^"']+)["']/g)) evidence.add(m[1]);
        continue;
      }
      if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
      const text = fs.readFileSync(full, 'utf-8');
      // 探测器产出的 ruleId
      for (const m of text.matchAll(/ruleId:\s*'([^']+)'/g)) evidence.add(m[1]);
      // 坏味道类型 / 检测器常量（如 FS_DETECTOR_ID = 'garbage.detect.fs'）
      for (const m of text.matchAll(/'([a-z][a-z0-9]*[.-][a-z0-9.-]+)'/g)) evidence.add(m[1]);
      // 产出标识（恶意代码类型 / 坏味道类型等裸字符串常量）
      for (const m of text.matchAll(/type:\s*'([a-z][a-z0-9-]+)'/g)) evidence.add(m[1]);
      // 坏味道类型（refactor 的类型表是裸字符串）
      for (const m of text.matchAll(/^\s{4}'([a-z][a-z0-9-]{4,})':\s*'/gm)) evidence.add(m[1]);
    }
  };

  walk(path.join(REPO_ROOT, 'packages'));
  return evidence;
}

const EVIDENCE = collectEvidence();

/** 标识符是否真实存在（精确匹配，或作为前缀匹配探测器命名空间） */
function hasEvidence(identifier: string): boolean {
  if (EVIDENCE.has(identifier)) return true;
  for (const candidate of EVIDENCE) {
    if (candidate.startsWith(`${identifier}.`)) return true;
  }
  return false;
}

describe('能力注册表 — 结构约束', () => {
  it('每条声明都有稳定 id、域、标签与状态', () => {
    for (const cap of CAPABILITY_REGISTRY) {
      expect(cap.id, '能力 id 不得为空').toBeTruthy();
      expect(cap.label, `能力 ${cap.id} 缺标签`).toBeTruthy();
      expect(['implemented', 'planned', 'deprecated']).toContain(cap.status);
    }
  });

  it('能力 id 全局唯一', () => {
    const ids = CAPABILITY_REGISTRY.map((c) => c.id);
    const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(dup, `重复的能力 id: ${dup.join(', ')}`).toEqual([]);
  });

  it('能力 id 带域前缀（便于按 id 反查归属域）', () => {
    for (const cap of CAPABILITY_REGISTRY) {
      expect(cap.id.startsWith(cap.domain), `能力 ${cap.id} 的 id 应以域 ${cap.domain} 开头`).toBe(
        true,
      );
    }
  });

  it('声明为 implemented 的能力必须给出实现证据', () => {
    const withoutEvidence = findCapabilitiesWithoutEvidence();
    expect(
      withoutEvidence.map((c) => c.id),
      '这些能力宣称已实现却指不出实现在哪 —— 等于「宣称有、但没实现」',
    ).toEqual([]);
  });

  it('planned / deprecated 的能力必须写明原因（不能默默不实现）', () => {
    for (const cap of CAPABILITY_REGISTRY) {
      if (cap.status === 'implemented') continue;
      expect(cap.note, `能力 ${cap.id}（${cap.status}）必须说明原因`).toBeTruthy();
    }
  });

  it('planned / deprecated 的能力不得声称已有实现', () => {
    for (const cap of CAPABILITY_REGISTRY) {
      if (cap.status === 'implemented') continue;
      expect(cap.implementedBy, `能力 ${cap.id} 状态为 ${cap.status}，不应带实现证据`).toEqual([]);
    }
  });
});

describe('能力注册表 — 实现证据可达性', () => {
  it('所有 implemented 能力的实现证据都能在真实代码里找到', () => {
    const missing: string[] = [];
    for (const cap of CAPABILITY_REGISTRY) {
      if (cap.status !== 'implemented') continue;
      for (const identifier of cap.implementedBy) {
        if (!hasEvidence(identifier)) missing.push(`${cap.id} → ${identifier}`);
      }
    }
    expect(missing, '这些实现证据在代码里不存在 —— 能力清单与实现漂移了').toEqual([]);
  });

  it('SOP 规则类证据必须是 active 状态（draft 规则不算实现）', () => {
    // SOP 规则 id 的证据必须能在规则模板里找到，且不是 draft
    const ruleDir = path.join(REPO_ROOT, 'packages/kernel/src/sop/presets');
    const ruleStatuses = new Map<string, string>();
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.yml')) continue;
        const text = fs.readFileSync(full, 'utf-8');
        const id = text.match(/^\s*id:\s*"([^"]+)"/m)?.[1];
        const status = text.match(/^\s*status:\s*"([^"]+)"/m)?.[1];
        if (id) ruleStatuses.set(id, status ?? 'unknown');
      }
    };
    walk(ruleDir);

    const suspicious: string[] = [];
    for (const cap of CAPABILITY_REGISTRY) {
      if (cap.status !== 'implemented') continue;
      for (const identifier of cap.implementedBy) {
        const status = ruleStatuses.get(identifier);
        // 只有当它是已知规则 id 时才检查状态（探测器前缀不在规则表里）
        if (status !== undefined && status !== 'active') {
          suspicious.push(`${cap.id} → ${identifier}（规则状态 ${status}）`);
        }
      }
    }
    expect(suspicious, '这些能力依赖非 active 规则 —— 规则未激活时能力不成立').toEqual([]);
  });
});

describe('能力注册表 — 按域查询', () => {
  it('implemented 与 unimplemented 互补且无重叠', () => {
    for (const [domain, caps] of CAPABILITIES_BY_DOMAIN) {
      const implemented = implementedCapabilities(domain);
      const unimplemented = unimplementedCapabilities(domain);
      expect(implemented.length + unimplemented.length).toBe(caps.length);
      const implementedIds = new Set(implemented.map((c) => c.id));
      for (const cap of unimplemented) {
        expect(implementedIds.has(cap.id), '能力不应同时出现在两个集合里').toBe(false);
      }
    }
  });

  it('性能域的现代化 API / 定时器仍标记为未实现（UI 不得宣称），ReDoS 已落地', () => {
    const unimplemented = unimplementedCapabilities('performance').map((c) => c.id);
    // ReDoS 已由原生 RedosDetectorImpl 落地并转 implemented（2026-11-03）
    expect(unimplemented).not.toContain('performance.redos');
    expect(unimplemented).toContain('performance.modern-api');
    expect(unimplemented).toContain('performance.timer');
    // 且必须给出实现证据
    const redos = (CAPABILITIES_BY_DOMAIN.get('performance') ?? []).find(
      (c) => c.id === 'performance.redos',
    );
    expect(redos?.status).toBe('implemented');
    expect(redos?.implementedBy.length).toBeGreaterThan(0);
  });

  it('安全域的「规范检查」与「依赖检查」均被标记为已移交', () => {
    const caps = CAPABILITIES_BY_DOMAIN.get('security') ?? [];
    const standard = caps.find((c) => c.id === 'security.standard');
    // 代码规范检查归项目体检；安全编码规范的条款由合规基线呈现，安全域不再单列
    expect(standard?.status).toBe('deprecated');
    const dependency = caps.find((c) => c.id === 'security.dependency');
    expect(dependency?.status).toBe('deprecated');
  });

  it('垃圾域的「重复代码」被标记为已移交重构域', () => {
    const caps = CAPABILITIES_BY_DOMAIN.get('garbage') ?? [];
    const dup = caps.find((c) => c.id === 'garbage.duplicate-code');
    expect(dup?.status).toBe('deprecated');
  });
});
