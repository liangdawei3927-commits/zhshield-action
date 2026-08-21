/**
 * PyPI 恶意包特征库（pypi-threat-scanner.ts）
 *
 * 对 Python 依赖清单（requirements.txt / Pipfile.lock / pyproject.toml）做供应链投毒检测：
 *   1. 精确黑名单 — 已知恶意 / 仿冒包名（已被社区确认并移除的包）
 *   2. 仿冒检测 — 与高频流行包名做编辑距离比对（typosquatting）
 * 纯静态分析，无需联网；产出 type='supply-chain' 的 MalwareItem。
 */
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { MalwareItem } from './types';

/** 已知恶意 / 仿冒 PyPI 包（社区确认并已从 PyPI 移除，仅收录整名即为恶意的包） */
const KNOWN_MALICIOUS_PACKAGES = new Set<string>([
  'pytorch',      // 冒名 torch 的投毒包，安装即窃密（2023 已移除）
  'urlib3',       // urllib3 的 typosquatting 投毒包（已移除）
  'jeilyfish',    // jellyfish 的 typosquatting，携带木马（已移除）
  'hostpy',       // setup.py 窃取系统信息的恶意包（已移除）
]);

/** 高频流行包名：仿冒检测基准，同时作为合法白名单（避免命中真实包） */
const KNOWN_POPULAR_PACKAGES = new Set<string>([
  'requests', 'numpy', 'pandas', 'django', 'flask', 'fastapi', 'torch',
  'tensorflow', 'scikit-learn', 'matplotlib', 'scipy', 'boto3', 'pytest',
  'beautifulsoup4', 'lxml', 'click', 'jinja2', 'celery', 'sqlalchemy',
  'redis', 'urllib3', 'httpx', 'aiohttp', 'pillow', 'pydantic', 'tqdm',
  'rich', 'typer', 'uvicorn', 'gunicorn', 'streamlit', 'transformers',
  'openai', 'nltk', 'spacy', 'setuptools', 'pip', 'wheel',
]);

/** PyPI 包名大小写不敏感，且 _ 与 - 等价（PEP 503 规范化）；统一小写并将 - 归一为 _ */
function normalizePyName(name: string): string {
  return name.toLowerCase().replace(/-/g, '_');
}

const MALICIOUS_LOOKUP = new Set<string>([...KNOWN_MALICIOUS_PACKAGES].map(normalizePyName));
const POPULAR_LOOKUP = new Set<string>([...KNOWN_POPULAR_PACKAGES].map(normalizePyName));

/** 编辑距离阈值：短包名更宽松（仿冒通常只差一两个字符） */
function typosquatThreshold(name: string): number {
  return name.length <= 8 ? 1 : 2;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = new Array<number>(n + 1).fill(0).map((_, j) => j);
  for (let i = 1; i <= m; i++) {
    const curr = new Array<number>(n + 1).fill(0);
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev.splice(0, prev.length, ...curr);
  }
  return prev[n];
}

/** 从引号值中提取包名（剥离 extras 与版本说明符；如 "flask[async]>=2.0" → flask） */
function quotedPackageName(value: string): string | null {
  const withoutExtras = value.replace(/\[.*?\]/g, '');
  const m = withoutExtras.match(/^[A-Za-z0-9_.-]+/);
  return m ? m[0] : null;
}

/** requirements.txt：逐行剥离 # 注释，跳过空行与以 - 开头的选项行，extras 与版本说明符由 quotedPackageName 剥离 */
function extractRequirementsNames(content: string): string[] {
  const names = new Set<string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, '').trim();
    if (line === '' || line.startsWith('-')) continue;
    const name = quotedPackageName(line);
    if (name) names.add(name);
  }
  return [...names];
}

/** Pipfile.lock JSON：default / develop 两个区块的键即包名 */
function extractPipfileNames(content: string): string[] {
  const data = JSON.parse(content) as Record<string, unknown>;
  const names = new Set<string>();
  for (const section of ['default', 'develop']) {
    const deps = data[section];
    if (deps && typeof deps === 'object') {
      for (const name of Object.keys(deps as Record<string, unknown>)) {
        if (name !== '_meta') names.add(name);
      }
    }
  }
  return [...names];
}

/**
 * pyproject.toml：按节拆分，仅处理目标区块——
 *   [project] 的 dependencies 数组取双引号包名（PEP 621）；
 *   [tool.poetry.dependencies] / [tool.uv.dependencies] 的表键即包名（值为版本约束，非包名）。
 * 区块头大小写不敏感；包名后续统一 _↔- 归一。
 */
function extractPyprojectNames(content: string): string[] {
  const names = new Set<string>();
  const sections = content.split(/^\s*\[/m);
  for (const section of sections) {
    const header = section.match(/^([^\]]+)\]/);
    if (!header) continue;
    const sectionName = header[1].trim().toLowerCase();
    if (sectionName === 'project') {
      const depsBlock = section.match(/dependencies\s*=\s*\[/);
      if (!depsBlock) continue;
      const block = section.slice(section.indexOf(depsBlock[0]) + depsBlock[0].length);
      for (const m of block.matchAll(/"([^"]+)"/g)) {
        const name = quotedPackageName(m[1]);
        if (name) names.add(name);
      }
    } else if (sectionName === 'tool.poetry.dependencies' || sectionName === 'tool.uv.dependencies') {
      for (const line of section.split(/\r?\n/)) {
        if (line.trim().startsWith('[')) continue;
        const key = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=/);
        if (key) names.add(key[1]);
      }
    }
  }
  return [...names];
}

/** 按优先级探测 Python 依赖清单（requirements.txt → Pipfile.lock → pyproject.toml），无清单时返回 null */
function findPythonManifest(projectPath: string): { file: string; names: string[] } | null {
  const requirementsPath = path.join(projectPath, 'requirements.txt');
  if (fs.existsSync(requirementsPath)) {
    return { file: requirementsPath, names: extractRequirementsNames(fs.readFileSync(requirementsPath, 'utf-8')) };
  }
  const pipfilePath = path.join(projectPath, 'Pipfile.lock');
  if (fs.existsSync(pipfilePath)) {
    return { file: pipfilePath, names: extractPipfileNames(fs.readFileSync(pipfilePath, 'utf-8')) };
  }
  const pyprojectPath = path.join(projectPath, 'pyproject.toml');
  if (fs.existsSync(pyprojectPath)) {
    return { file: pyprojectPath, names: extractPyprojectNames(fs.readFileSync(pyprojectPath, 'utf-8')) };
  }
  return null;
}

/** 扫描项目 Python 依赖清单（requirements.txt 优先，其次 Pipfile.lock / pyproject.toml），返回命中供应链威胁的 MalwareItem 列表 */
export async function scanPypiThreats(projectPath: string): Promise<MalwareItem[]> {
  let manifest: { file: string; names: string[] } | null;
  try {
    manifest = findPythonManifest(projectPath);
  } catch {
    return [];
  }
  if (!manifest || manifest.names.length === 0) return [];

  const items: MalwareItem[] = [];
  for (const name of manifest.names) {
    const norm = normalizePyName(name);

    if (MALICIOUS_LOOKUP.has(norm)) {
      items.push(makeThreatItem(manifest.file, name, {
        severity: 'critical',
        title: '已知恶意 PyPI 包（供应链投毒黑名单）',
        pattern: 'pypi-threat-db',
        evidence: `${path.basename(manifest.file)} 引用了黑名单包 ${name}`,
      }));
      continue;
    }

    if (POPULAR_LOOKUP.has(norm)) continue;

    const threshold = typosquatThreshold(norm);
    for (const popular of KNOWN_POPULAR_PACKAGES) {
      const distance = levenshtein(norm, normalizePyName(popular));
      if (distance >= 1 && distance <= threshold) {
        items.push(makeThreatItem(manifest.file, name, {
          severity: 'high',
          title: '疑似仿冒包（typosquatting）',
          pattern: `typosquat:${popular}:${distance}`,
          evidence: `包名 ${name} 与流行包 ${popular} 编辑距离为 ${distance}`,
        }));
        break;
      }
    }
  }
  return items;
}

function makeThreatItem(
  manifestPath: string,
  name: string,
  meta: { severity: MalwareItem['severity']; title: string; pattern: string; evidence: string },
): MalwareItem {
  return {
    id: randomUUID(),
    type: 'supply-chain',
    severity: meta.severity,
    title: meta.title,
    description: `检测到供应链威胁：${name}`,
    file: manifestPath,
    line: 0,
    pattern: meta.pattern,
    evidence: meta.evidence,
  };
}
