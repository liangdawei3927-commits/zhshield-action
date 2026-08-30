// ─── 路径范围匹配器（F5 权限边界）────────────────────────

const ALNUM_RE = /[a-zA-Z0-9_-]/;
const regexCache = new Map<string, RegExp[]>();

/** glob 最大长度（防超长输入撑爆正则编译 / 回溯） */
const MAX_GLOB_LENGTH = 512;
/** glob 安全字符集：仅允许常见 glob 元字符与路径字符 */
const SAFE_GLOB_RE = /^[a-zA-Z0-9_*?{}/,.-]+$/;

function isSafeGlob(glob: string): boolean {
  return glob.length <= MAX_GLOB_LENGTH && SAFE_GLOB_RE.test(glob);
}

function normalizePath(p: string): string {
  let out = p.replace(/\\/g, '/');
  while (out.startsWith('./')) out = out.slice(2);
  while (out.startsWith('/')) out = out.slice(1);
  return out;
}

/** 展开顶层 {a,b,c} 备选（不嵌套）为多个 glob */
function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf('{');
  if (open === -1) return [pattern];
  const close = pattern.indexOf('}', open);
  if (close === -1) return [pattern];
  const head = pattern.slice(0, open);
  const tail = pattern.slice(close + 1);
  return pattern
    .slice(open + 1, close)
    .split(',')
    .flatMap((alt) => expandBraces(head + alt + tail));
}

/** 处理 '*' 通配：globstar「双星」匹配零层或多层目录，「双星」跨段，「星」单段；返回 [追加片段, 新索引] */
function appendStar(re: string, glob: string, i: number): [string, number] {
  if (glob[i + 1] === '*') {
    if ((i === 0 || glob[i - 1] === '/') && glob[i + 2] === '/') {
      return [re + '(?:[^/]*/)*', i + 3];
    }
    return [re + '.*', i + 2];
  }
  return [re + '[^/]*', i + 1];
}

/** 单个 glob → 锚定正则：globstar「双星」匹配零层或多层目录，「双星」跨段，「星」单段，「问号」单字符 */
function globToRegExp(glob: string): RegExp {
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i] as string;
    if (c === '*') {
      [re, i] = appendStar(re, glob, i);
      continue;
    }
    if (c === '?') {
      re += '[^/]';
      i += 1;
      continue;
    }
    re += ALNUM_RE.test(c) ? c : '\\' + c;
    i += 1;
  }
  return new RegExp(`^${re}$`);
}

function compilePattern(pattern: string): RegExp[] {
  if (!isSafeGlob(pattern)) return [];
  const cached = regexCache.get(pattern);
  if (cached) return cached;
  const regexes = expandBraces(pattern).map(globToRegExp);
  regexCache.set(pattern, regexes);
  return regexes;
}

/** 不含 `/` 的模式按 basename 匹配（惯例），否则匹配完整规范化路径 */
export function matchGlobPath(file: string, pattern: string): boolean {
  const normalized = normalizePath(file);
  const target = pattern.includes('/')
    ? normalized
    : normalized.slice(normalized.lastIndexOf('/') + 1);
  return compilePattern(pattern).some((re) => re.test(target));
}
