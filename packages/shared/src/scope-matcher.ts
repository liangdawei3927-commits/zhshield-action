// ─── 路径范围匹配器（F5 权限边界）────────────────────────

const regexCache = new Map<string, RegExp[]>();

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

/** 单个 glob → 锚定正则：globstar「双星」匹配零层或多层目录，「双星」跨段，「星」单段，「问号」单字符 */
function globToRegExp(glob: string): RegExp {
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i] as string;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if ((i === 0 || glob[i - 1] === '/') && glob[i + 2] === '/') {
          re += '(?:[^/]*/)*';
          i += 3;
        } else {
          re += '.*';
          i += 2;
        }
      } else {
        re += '[^/]*';
        i += 1;
      }
      continue;
    }
    if (c === '?') {
      re += '[^/]';
      i += 1;
      continue;
    }
    re += /[a-zA-Z0-9_-]/.test(c) ? c : '\\' + c;
    i += 1;
  }
  return new RegExp(`^${re}$`);
}

function compilePattern(pattern: string): RegExp[] {
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
