/**
 * 手写 semver 范围匹配器（lockfile-verifier-semver.ts）
 *
 * 从 lockfile-verifier.ts 拆分而来的纯函数区段：支持 ^ ~ >= <= > < = == 精确、
 * x 通配、连字符范围、|| 与 && 组合。零新依赖、零网络请求。
 */

// ────────────────────────────── 模块级正则常量（避免每次调用重编译） ──────────────────────────────

/** 完整版本号解析：'1.2.3-beta.1' */
const VERSION_FULL_RE =
  /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
/** 纯数字检测 */
const DIGITS_RE = /^\d+$/;
/** 部分版本号：'1.2.x' / '1.2' / '1' */
const PARTIAL_VERSION_RE = /^(\d+)(?:\.(\d+|\*|x|X))?(?:\.(\d+|\*|x|X))?$/;
/** 通配符分量（x / X / *） */
const WILDCARD_COMPONENT_RE = /^[xX*]$/;
/** 完整三段语义版本 x.y.z */
const FULL_SEMVER_RE = /^(\d+\.){2}\d+$/;
/** 连字符范围 '1.0.0 - 2.0.0' */
const HYPHEN_RANGE_RE = /^\s*(\S+)\s+-\s+(\S+)\s*$/;
/** 替代集合拆分（逗号/空白） */
const ALT_SPLITTER_RE = /[\s,]+/;

// ────────────────────────────── semver 范围匹配（手写实现，零依赖） ──────────────────────────────

/** 解析后的版本号：主/次/修订数值 + 预发布标识 */
interface ParsedVersion {
  nums: [number, number, number];
  pre: string;
}

const ZERO: ParsedVersion = { nums: [0, 0, 0], pre: '' };

/** 解析完整版本号 '1.2.3-beta.1' → { nums, pre }；无法解析返回 null */
function parseVersion(input: string): ParsedVersion | null {
  const m = input.trim().match(VERSION_FULL_RE);
  if (!m) return null;
  return { nums: [Number(m[1] ?? 0), Number(m[2] ?? 0), Number(m[3] ?? 0)], pre: m[4] ?? '' };
}

/** 比较 [major, minor, patch] 数值部分 */
function compareCore(a: ParsedVersion, b: ParsedVersion): number {
  for (let i = 0; i < 3; i++) {
    if (a.nums[i] !== b.nums[i]) return a.nums[i] < b.nums[i] ? -1 : 1;
  }
  return 0;
}

/** 完整比较：数值相等时预发布 < 正式版 */
function compareFull(a: ParsedVersion, b: ParsedVersion): number {
  const c = compareCore(a, b);
  if (c !== 0) return c;
  if (a.pre === '' && b.pre !== '') return 1;
  if (a.pre !== '' && b.pre === '') return -1;
  return comparePreRelease(a.pre, b.pre);
}

/** 预发布标识逐段比较（semver 11）：数字段 < 字母标识，段数少者优先，全等为 0 */
function comparePreRelease(a: string, b: string): number {
  if (a === b) return 0;
  const ap = a.split('.');
  const bp = b.split('.');
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    const x = ap[i];
    const y = bp[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = DIGITS_RE.test(x);
    const yn = DIGITS_RE.test(y);
    if (xn && yn) return Number(x) < Number(y) ? -1 : 1;
    if (xn) return -1; // 数字标识 < 字母标识（semver 规则）
    if (yn) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** 解析部分版本 '1.2.x' / '1.2' / '1' → 已确定的数值段数量 */
function parsePartial(spec: string): number[] | null {
  const m = spec.match(PARTIAL_VERSION_RE);
  if (!m) return null;
  const nums: number[] = [Number(m[1])];
  if (m[2] !== undefined && !WILDCARD_COMPONENT_RE.test(m[2])) nums.push(Number(m[2]));
  if (m[3] !== undefined && !WILDCARD_COMPONENT_RE.test(m[3])) nums.push(Number(m[3]));
  return nums;
}

/** 将部分版本填零为下界 */
function toLowerBound(nums: number[]): ParsedVersion {
  return { nums: [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0], pre: '' };
}

/** 部分版本满足判定：'1.2.x' 命中任意 1.2.*；'1.2' 视为 1.2.x；'1' 视为 1.x */
function partialSatisfies(ver: ParsedVersion, spec: string): boolean {
  const nums = parsePartial(spec);
  if (!nums) return false;
  if (compareCore(ver, toLowerBound(nums)) < 0) return false;
  const hi =
    nums.length === 1
      ? [nums[0] + 1, 0, 0]
      : nums.length === 2
        ? [nums[0], nums[1] + 1, 0]
        : [nums[0], nums[1], nums[2] + 1];
  return compareCore(ver, { nums: [hi[0], hi[1], hi[2]], pre: '' }) < 0;
}

/** ^ 范围：^1.2.3 → >=1.2.3 <2.0.0；^0.2.3 → >=0.2.3 <0.3.0；^0.0.3 → >=0.0.3 <0.0.4 */
function caretSatisfies(ver: ParsedVersion, spec: string): boolean {
  const nums = parsePartial(spec);
  if (!nums) return false;
  if (compareFull(ver, toLowerBound(nums)) < 0) return false;
  let hi: [number, number, number];
  if ((nums[0] ?? 0) !== 0) hi = [nums[0] + 1, 0, 0];
  else if ((nums[1] ?? 0) !== 0) hi = [0, nums[1] + 1, 0];
  else hi = [0, 0, (nums[2] ?? 0) + 1];
  return compareCore(ver, { nums: hi, pre: '' }) < 0;
}

/** ~ 范围：~1.2.3 → >=1.2.3 <1.3.0；~1.2 → >=1.2.0 <1.3.0；~1 → >=1.0.0 <2.0.0 */
function tildeSatisfies(ver: ParsedVersion, spec: string): boolean {
  const nums = parsePartial(spec);
  if (!nums) return false;
  if (compareFull(ver, toLowerBound(nums)) < 0) return false;
  const hi = nums.length >= 2 ? [nums[0], nums[1] + 1, 0] : [nums[0] + 1, 0, 0];
  return compareCore(ver, { nums: [hi[0], hi[1], hi[2]], pre: '' }) < 0;
}

const COMPARATOR_OP_RE = /^(>=|<=|>|<|===|==|=|~|\^)?(.+)$/;

/** 单比较符判定（如 '>=1.2.3'、'^4.17.21'、'1.2.x'、'*'） */
function satisfiesComparator(ver: ParsedVersion, token: string): boolean {
  const m = token.trim().match(COMPARATOR_OP_RE);
  if (!m) return false;
  const op = m[1] ?? '';
  const spec = m[2].trim();
  if (spec === '' || spec === '*' || spec === 'latest') return true;
  if (op === '^') return caretSatisfies(ver, spec);
  if (op === '~') return tildeSatisfies(ver, spec);
  if (op === '') return satisfiesBare(ver, spec);
  return satisfiesOperator(ver, op, spec);
}

/** 裸版本：完整 x.y.z 精确匹配；部分版本按 x.y / x 区间处理 */
function satisfiesBare(ver: ParsedVersion, spec: string): boolean {
  const full = parseVersion(spec);
  if (full && FULL_SEMVER_RE.test(spec)) return compareFull(ver, full) === 0;
  return partialSatisfies(ver, spec);
}

/** 带比较符约束：'>=1.2' 这类部分版本按填零下界比较 */
function satisfiesOperator(ver: ParsedVersion, op: string, spec: string): boolean {
  const target = parseVersion(spec);
  if (!target) {
    if (op === '>=' || op === '>') {
      const lower = toLowerBound(parsePartial(spec) ?? []);
      return op === '>=' ? compareFull(ver, lower) >= 0 : compareFull(ver, lower) > 0;
    }
    return false;
  }
  switch (op) {
    case '>=':
      return compareFull(ver, target) >= 0;
    case '<=':
      return compareFull(ver, target) <= 0;
    case '>':
      return compareFull(ver, target) > 0;
    case '<':
      return compareFull(ver, target) < 0;
    case '=':
    case '==':
    case '===':
      return compareFull(ver, target) === 0;
    default:
      return false;
  }
}

/** 一个备选集合（&& 关系）：逗号/空白分隔的比较符全部满足才成立 */
function satisfiesAlternative(ver: ParsedVersion, alt: string): boolean {
  // 预发布版本仅当范围本身带预发布标识时才可能满足（npm 语义）
  if (ver.pre !== '' && !alt.includes('-')) return false;
  const hyphen = alt.match(HYPHEN_RANGE_RE);
  if (hyphen) {
    const lo = parseVersion(hyphen[1]) ?? ZERO;
    const hi = parseVersion(hyphen[2]) ?? ZERO;
    return compareFull(ver, lo) >= 0 && compareFull(ver, hi) <= 0;
  }
  const tokens = alt.split(ALT_SPLITTER_RE).filter((t) => t.length > 0);
  return tokens.every((token) => satisfiesComparator(ver, token));
}

/** 版本是否满足声明范围（支持 ^ ~ >= <= > < = == 精确、x 通配、连字符、|| 与 && 组合） */
export function satisfiesVersion(version: string, range: string): boolean {
  const ver = parseVersion(version);
  if (!ver) return false;
  const trimmed = range.trim();
  if (trimmed === '' || trimmed === '*' || trimmed === 'latest') return true;
  return trimmed.split('||').some((alt) => satisfiesAlternative(ver, alt));
}
