// lockfile 依赖解析（正则行解析，无外部依赖）：package-lock / pnpm-lock / yarn.lock / go.sum /
// Cargo.lock / poetry.lock / uv.lock / pom.xml / Pipfile.lock——M0 只存清单（name + version）。

import * as fs from 'node:fs';
import * as path from 'node:path';
import { isRecord } from '../fs-utils';

const PNPM_IMPORTER_RE = /^ {2}(\S.*):\s*$/;
const PNPM_SECTION_RE = /^ {4}(dependencies|devDependencies|optionalDependencies):\s*$/;
const PNPM_HEADER_RE = /^ {6,8}([a-z0-9@._/-]+):\s*$/;
const PNPM_VERSION_RE = /^ {8,10}(?:version|specifier):\s*(.+)$/;
const YARN_STRIP_QUOTES_RE = /^"|"$/g;
const YARN_STRIP_COLON_RE = /:$/;
const YARN_VERSION_RE = /^\s{2}version "([^"]+)"/;
const TOML_NAME_RE = /^name\s*=\s*"([^"]+)"/;
const TOML_VERSION_RE = /^version\s*=\s*"([^"]+)"/;
const POM_GROUP_RE = /<groupId>([^<]+)<\/groupId>/;
const POM_ARTIFACT_RE = /<artifactId>([^<]+)<\/artifactId>/;
const POM_VERSION_RE = /<version>([^<]+)<\/version>/;

export interface ParsedLockfile {
  ruleId: string;
  packageManager: string;
  direct: Array<{ name: string; version: string }>;
}

interface DepName {
  name: string;
  version: string;
}

function readFile(root: string, rel: string): string {
  return fs.readFileSync(path.join(root, ...rel.split('/')), 'utf-8');
}

function dedupe(deps: DepName[]): DepName[] {
  const seen = new Set<string>();
  const out: DepName[] = [];
  for (const dep of deps.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const key = `${dep.name}@${dep.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(dep);
  }
  return out;
}

function parsePackageLock(root: string, rel: string): ParsedLockfile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFile(root, rel));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const packages = parsed.packages;
  if (!isRecord(packages)) return null;
  const rootEntry = packages[''];
  if (!isRecord(rootEntry)) return null;
  const direct: DepName[] = [];
  for (const section of ['dependencies', 'devDependencies'] as const) {
    const deps = rootEntry[section];
    if (!isRecord(deps)) continue;
    for (const [name, spec] of Object.entries(deps)) {
      direct.push({ name, version: typeof spec === 'string' ? spec : '' });
    }
  }
  if (direct.length === 0) return null;
  return { ruleId: 'lockfile:package-lock', packageManager: 'npm', direct: dedupe(direct) };
}

/**
 * pnpm-lock.yaml importers 段直接依赖（v6：依赖名缩进 8 空格，specifier/version 10 空格；
 * v9：依赖名 6 空格，specifier/version 8 空格）。version 取 specifier 或 version 行（后到先得）。
 */
function parsePnpmImporters(content: string): DepName[] {
  const direct: DepName[] = [];
  let inImporters = false;
  let inDeps = false;
  let pending: DepName | null = null;
  const flush = (): void => {
    if (pending !== null && pending.version.length > 0) direct.push(pending);
    pending = null;
  };
  for (const raw of content.split('\n')) {
    if (raw.trim() === 'importers:') {
      inImporters = true;
      continue;
    }
    if (!inImporters) continue;
    if (raw.trim() === 'packages:') break;
    const importer = raw.match(PNPM_IMPORTER_RE);
    if (importer !== null) {
      flush();
      inDeps = false;
      continue;
    }
    const section = raw.match(PNPM_SECTION_RE);
    if (section !== null) {
      flush();
      inDeps = true;
      continue;
    }
    if (!inDeps) continue;
    const header = raw.match(PNPM_HEADER_RE);
    if (header !== null) {
      flush();
      pending = { name: header[1], version: '' };
      continue;
    }
    const version = raw.match(PNPM_VERSION_RE);
    if (version !== null && pending !== null) {
      pending.version = version[1].trim();
    }
  }
  flush();
  return direct;
}

function parsePnpmLock(root: string, rel: string): ParsedLockfile | null {
  let content: string;
  try {
    content = readFile(root, rel);
  } catch {
    return null;
  }
  const direct = parsePnpmImporters(content);
  if (direct.length === 0) return null;
  return { ruleId: 'lockfile:pnpm', packageManager: 'pnpm', direct: dedupe(direct) };
}

function parseYarnLock(root: string, rel: string): ParsedLockfile | null {
  let content: string;
  try {
    content = readFile(root, rel);
  } catch {
    return null;
  }
  const direct: DepName[] = [];
  let pending: DepName | null = null;
  for (const raw of content.split('\n')) {
    if (raw.length === 0) continue;
    if (raw[0] !== ' ' && raw.trimEnd().endsWith(':')) {
      if (pending !== null) direct.push(pending);
      const key = raw.trim().replace(YARN_STRIP_QUOTES_RE, '').replace(YARN_STRIP_COLON_RE, '');
      const at = key.lastIndexOf('@');
      pending = { name: at > 0 ? key.slice(0, at) : key, version: '' };
      continue;
    }
    if (pending === null) continue;
    const version = raw.match(YARN_VERSION_RE);
    if (version !== null) {
      pending.version = version[1];
      direct.push(pending);
      pending = null;
    }
  }
  if (pending !== null) direct.push(pending);
  if (direct.length === 0) return null;
  return { ruleId: 'lockfile:yarn', packageManager: 'yarn', direct: dedupe(direct) };
}

function parseGoSum(root: string, rel: string): ParsedLockfile | null {
  let content: string;
  try {
    content = readFile(root, rel);
  } catch {
    return null;
  }
  const direct: DepName[] = [];
  for (const match of content.matchAll(/^([^\s]+)\s+(v[^\s]+)/gm)) {
    direct.push({ name: match[1], version: match[2] });
  }
  if (direct.length === 0) return null;
  return { ruleId: 'lockfile:go-sum', packageManager: 'go', direct: dedupe(direct) };
}

/** Cargo.lock / poetry.lock / uv.lock 的 `name = "..."` / `version = "..."` 键值行解析。 */
function parsePackageStyle(
  root: string,
  rel: string,
  ruleId: string,
  packageManager: string,
): ParsedLockfile | null {
  let content: string;
  try {
    content = readFile(root, rel);
  } catch {
    return null;
  }
  const direct: DepName[] = [];
  let pending: DepName | null = null;
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    const name = line.match(TOML_NAME_RE);
    if (name !== null) {
      if (pending !== null) direct.push(pending);
      pending = { name: name[1], version: '' };
      continue;
    }
    const version = line.match(TOML_VERSION_RE);
    if (version !== null && pending !== null) pending.version = version[1];
  }
  if (pending !== null) direct.push(pending);
  if (direct.length === 0) return null;
  return { ruleId, packageManager, direct: dedupe(direct) };
}

function parsePomXml(root: string, rel: string): ParsedLockfile | null {
  let content: string;
  try {
    content = readFile(root, rel);
  } catch {
    return null;
  }
  const direct: DepName[] = [];
  for (const block of content.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const group = block[1].match(POM_GROUP_RE)?.[1] ?? '';
    const artifact = block[1].match(POM_ARTIFACT_RE)?.[1] ?? '';
    const version = block[1].match(POM_VERSION_RE)?.[1] ?? '';
    const name = [group, artifact].filter((s) => s.length > 0).join(':');
    if (name.length > 0) direct.push({ name, version: version.trim() });
  }
  if (direct.length === 0) return null;
  return { ruleId: 'lockfile:pom', packageManager: 'maven', direct: dedupe(direct) };
}

function parsePipfileLock(root: string, rel: string): ParsedLockfile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFile(root, rel));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const direct: DepName[] = [];
  for (const section of ['default', 'develop'] as const) {
    const deps = parsed[section];
    if (!isRecord(deps)) continue;
    for (const [name, spec] of Object.entries(deps)) {
      const version = isRecord(spec) && typeof spec.version === 'string' ? spec.version : '';
      direct.push({ name, version });
    }
  }
  if (direct.length === 0) return null;
  return { ruleId: 'lockfile:pipfile-lock', packageManager: 'pipenv', direct: dedupe(direct) };
}

export function parseLockfile(root: string, rel: string, name: string): ParsedLockfile | null {
  switch (name) {
    case 'package-lock.json':
      return parsePackageLock(root, rel);
    case 'pnpm-lock.yaml':
      return parsePnpmLock(root, rel);
    case 'yarn.lock':
      return parseYarnLock(root, rel);
    case 'go.sum':
      return parseGoSum(root, rel);
    case 'Cargo.lock':
      return parsePackageStyle(root, rel, 'lockfile:cargo', 'cargo');
    case 'poetry.lock':
      return parsePackageStyle(root, rel, 'lockfile:poetry', 'poetry');
    case 'uv.lock':
      return parsePackageStyle(root, rel, 'lockfile:uv', 'uv');
    case 'pom.xml':
      return parsePomXml(root, rel);
    case 'Pipfile.lock':
      return parsePipfileLock(root, rel);
    default:
      return null;
  }
}
