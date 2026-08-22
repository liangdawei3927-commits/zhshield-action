import { describe, it, expect } from 'vitest';
import { SopDiffCalculator } from '../sop/sop-diff-calculator';
// 仅类型导入（编译期擦除）：运行时加载 @zh/kernel 全量 barrel 会让 vitest 挂起
import type { SopRegistry, SopRule } from '@zh/kernel';

// ─── 旧实现留档（characterization oracle，重构前逐字拷贝自 sop-diff-calculator.ts）───
function legacyFindAddedRules(
  activeRules: SopRule[],
  unchanged: string[],
  modified: SopRule[],
): SopRule[] {
  const added: SopRule[] = [];
  for (const rule of activeRules) {
    if (!unchanged.includes(rule.id) && !modified.some((m) => m.id === rule.id)) {
      added.push(rule);
    }
  }
  return added;
}

function makeRule(id: string, updatedAt = new Date('2026-01-01T00:00:00Z')): SopRule {
  return {
    id,
    name: id,
    domain: 'guard',
    action: 'scan',
    source: 'official',
    description: '',
    status: 'active',
    executionMode: 'sync',
    severity: 'medium',
    applicableEngines: ['guard'],
    content: {},
    tags: [],
    falsePositiveCount: 0,
    truePositiveCount: 0,
    createdAt: updatedAt,
    updatedAt,
  };
}

/** 可复现的伪随机数（LCG），保证随机化等价测试确定性 */
function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

type FindAddedFn = (active: SopRule[], unchanged: string[], modified: SopRule[]) => SopRule[];

/** 白盒访问私有方法：仅用于 findAddedRules 的直接等价对照与性能测量 */
function getFindAdded(): FindAddedFn {
  const calc = new SopDiffCalculator();
  const fn = (calc as unknown as { findAddedRules: FindAddedFn }).findAddedRules;
  return fn.bind(calc);
}

interface Fixture {
  active: SopRule[];
  unchanged: string[];
  modified: SopRule[];
}

/** 构造含重复 id / 三集合交叠的随机输入（重复处理是表征测试重点） */
function randomFixture(rand: () => number): Fixture {
  const idCount = 1 + Math.floor(rand() * 40);
  const ids = Array.from({ length: idCount }, (_, i) => `rule-${i}`);
  const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)] as T;
  const active: SopRule[] = Array.from({ length: idCount + Math.floor(rand() * 20) }, () =>
    makeRule(pick(ids)),
  );
  const unchanged: string[] = Array.from({ length: Math.floor(rand() * idCount) }, () => pick(ids));
  const modified: SopRule[] = Array.from({ length: Math.floor(rand() * idCount) }, () =>
    makeRule(pick(ids)),
  );
  return { active, unchanged, modified };
}

describe('SopDiffCalculator.findAddedRules 特征化（新旧实现等价）', () => {
  it('基础筛选：只保留既非 unchanged 也非 modified 的活跃规则', () => {
    const findAdded = getFindAdded();
    const a = makeRule('a');
    const b = makeRule('b');
    const c = makeRule('c');
    const result = findAdded([a, b, c], ['a'], [b]);
    expect(result).toEqual([c]);
  });

  it('保持 activeRules 的遍历顺序', () => {
    const findAdded = getFindAdded();
    const rules = ['x', 'y', 'z', 'w'].map((id) => makeRule(id));
    const result = findAdded(rules, ['w'], [makeRule('x')]);
    expect(result.map((r) => r.id)).toEqual(['y', 'z']);
  });

  it('activeRules 中重复 id 全部保留（与旧实现一致不去重）', () => {
    const findAdded = getFindAdded();
    const dup = makeRule('dup');
    const result = findAdded([dup, makeRule('known'), dup], ['known'], []);
    expect(result).toEqual([dup, dup]);
  });

  it('unchanged/modified 同时包含同一 id 时仍被排除', () => {
    const findAdded = getFindAdded();
    const result = findAdded([makeRule('a')], ['a'], [makeRule('a')]);
    expect(result).toEqual([]);
  });

  it('空输入边界：三个入参均为空返回空数组', () => {
    const findAdded = getFindAdded();
    expect(findAdded([], [], [])).toEqual([]);
  });

  it('200 组种子随机输入下新旧实现结果逐一相等（含重复与交叠）', () => {
    const findAdded = getFindAdded();
    for (let seed = 1; seed <= 200; seed++) {
      const { active, unchanged, modified } = randomFixture(seededRandom(seed));
      const expected = legacyFindAddedRules(active, unchanged, modified);
      expect(findAdded(active, unchanged, modified)).toEqual(expected);
    }
  });

  // ─── 公共 API 路径：computeDiff.added 与 oracle 推导一致 ───
  it('computeDiff 的 added 与旧实现推导结果一致（公共路径特征化）', () => {
    const rand = seededRandom(42);
    const { active, modified } = randomFixture(rand);

    const rules = active.map((r) =>
      modified.some((m) => m.id === r.id) ? { ...r, updatedAt: new Date('2026-06-01T00:00:00Z') } : r,
    );
    const registry = {
      getAll: () => rules,
      getActive: () => rules.filter((r) => r.status === 'active'),
    } as unknown as SopRegistry;

    const diff = new SopDiffCalculator().computeDiff(registry, '2025.12.31', '2026.01.02');
    const expected = legacyFindAddedRules(
      rules.filter((r) => r.status === 'active'),
      diff.unchanged,
      diff.modified,
    );
    expect(diff.added).toEqual(expected);
  });
});

describe('SopDiffCalculator.findAddedRules 性质（O(n) 验证）', () => {
  // 注意：同步死循环无法被 testTimeout 中断，基准规模必须保守取值
  function timeOnce(fn: () => unknown): number {
    const start = performance.now();
    fn();
    return performance.now() - start;
  }

  function bigInput(n: number): Fixture {
    const active = Array.from({ length: n }, (_, i) => makeRule(`rule-${i}`));
    const unchanged = Array.from({ length: n }, (_, i) => `old-${i}`);
    const modified = Array.from({ length: n }, (_, i) => makeRule(`mod-${i}`));
    return { active, unchanged, modified };
  }

  it(
    '线性证据：旧实现 6k 的耗时 > 新实现 48k（8 倍数据）耗时的 3 倍',
    // 墙钟计时对并行 worker 的 CPU 争用敏感，retry 提供公平重测机会
    { timeout: 120_000, retry: 2 },
    () => {
      const findAdded = getFindAdded();

      const legacyInput = bigInput(6_000);
      const tLegacy = timeOnce(() =>
        legacyFindAddedRules(legacyInput.active, legacyInput.unchanged, legacyInput.modified),
      );

      const largeInput = bigInput(48_000);
      const tCurrent = timeOnce(() =>
        findAdded(largeInput.active, largeInput.unchanged, largeInput.modified),
      );

      // 旧 O(n²)：6k 规模 ≈ 数千万次成员扫描；新 O(n)：48k 规模仅 ≈ 十万次级 Set 操作。
      // 若新实现退化为平方级，48k 输入将远慢于 6k 的旧实现，断言必然失败。
      expect(tLegacy).toBeGreaterThan(20);
      expect(tLegacy).toBeGreaterThan(tCurrent * 3);
    },
  );

  it(
    // 绝对墙钟上限在并行 worker 争用下不可复现（同机实测可膨胀 7 倍），
    // 改用自归一比值：线性 ≈8 倍，二次退化 ≈64 倍，阈值 20 可区分二者
    '绝对上限：100k 规模相对 12.5k 规模呈近线性（耗时比 < 20，二次退化时 ≈ 64）',
    { timeout: 30_000, retry: 2 },
    () => {
      const findAdded = getFindAdded();
      const small = bigInput(12_500);
      const large = bigInput(100_000);
      const tSmall = timeOnce(() => findAdded(small.active, small.unchanged, small.modified));
      const tLarge = timeOnce(() => findAdded(large.active, large.unchanged, large.modified));
      expect(tLarge / tSmall).toBeLessThan(20);
    },
  );
});
