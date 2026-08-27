import * as fs from 'fs';
import * as path from 'path';
import { safeJoin, safeResolve } from '@zh/shared';

/** 单帧堆栈位置 */
export interface StackFrame {
  functionName?: string;
  file: string;
  line: number;
  column: number;
}

/** 结构化定位结果：模块 / 功能 / 代码行 + 源码片段 */
export interface SourceLocation {
  module: string;
  file: string;
  line: number;
  column: number;
  functionName?: string;
  snippet?: string;
}

export interface LocateOptions {
  projectPath?: string;
}

interface SourceMapData {
  version: number;
  file?: string;
  sourceRoot?: string;
  sources: string[];
  names?: string[];
  mappings: string;
}

interface MappingSegment {
  genLine: number;
  genColumn: number;
  sourceIndex: number;
  originalLine: number;
  originalColumn: number;
  nameIndex?: number;
}

const FRAME_RE = /^\s*at\s+(.+)$/;
const PAREN_FRAME_RE = /^(.*?)\s+\(([^)]+)\)$/;
const LOCATION_RE = /(.+?):(\d+):(\d+)$/;
const REMOTE_URL_RE = /^https?:/;
const EXTENSION_RE = /\.[^.]+$/;
const SOURCE_MAPPING_URL_RE = /sourceMappingURL=([^\s]+)/;

/** 解析 V8 / Node 堆栈帧（支持 file://、webpack://、http(s):// 及 async 前缀） */
export function parseV8Stack(stack: string): StackFrame[] {
  const frames: StackFrame[] = [];
  for (const rawLine of stack.split('\n')) {
    const match = FRAME_RE.exec(rawLine);
    if (!match) continue;

    let text = match[1];
    let functionName: string | undefined;

    const parenMatch = PAREN_FRAME_RE.exec(text);
    if (parenMatch) {
      functionName = parenMatch[1].trim() || undefined;
      text = parenMatch[2];
    }

    const loc = LOCATION_RE.exec(text);
    if (!loc) continue;

    frames.push({
      functionName,
      file: loc[1],
      line: Number(loc[2]),
      column: Number(loc[3]),
    });
  }
  return frames;
}

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = new Map<string, number>();
for (let i = 0; i < B64_ALPHABET.length; i++) B64_INDEX.set(B64_ALPHABET[i], i);

/** 解码单个 base64-VLQ 段为字段数组（sourcemap v3 编码格式） */
function decodeVlqSegment(segment: string): number[] {
  const values: number[] = [];
  let result = 0;
  let shift = 0;
  for (const char of segment) {
    const digit = B64_INDEX.get(char) ?? 0;
    result |= (digit & 0x1f) << shift;
    if ((digit & 0x20) === 0) {
      // 低 1 位为符号位，其余为绝对值（右移）
      values.push((result & 1) === 1 ? -(result >> 1) : result >> 1);
      result = 0;
      shift = 0;
    } else {
      shift += 5;
    }
  }
  return values;
}

/** 解码 mappings 为绝对坐标段（字段间差值累计还原） */
function decodeMappings(mappings: string): MappingSegment[] {
  const segments: MappingSegment[] = [];
  let sourceIndex = 0;
  let originalLine = 0;
  let originalColumn = 0;
  let nameIndex = 0;

  mappings.split(';').forEach((lineStr, genLine) => {
    let genColumn = 0;
    for (const seg of lineStr.split(',')) {
      if (!seg) continue;
      const fields = decodeVlqSegment(seg);
      genColumn += fields[0] ?? 0;
      sourceIndex += fields[1] ?? 0;
      originalLine += fields[2] ?? 0;
      originalColumn += fields[3] ?? 0;
      if (fields.length > 4) nameIndex += fields[4];
      segments.push({ genLine, genColumn, sourceIndex, originalLine, originalColumn, nameIndex });
    }
  });
  return segments;
}

/** 将堆栈文件路径归一化为本地路径；无法落盘（远程 URL）返回 null */
function resolveLocalPath(file: string, projectPath?: string): string | null {
  let local = file;
  if (local.startsWith('file://')) local = local.slice('file://'.length);
  else if (local.startsWith('webpack:///')) {
    local = local.slice('webpack:///'.length);
    if (projectPath) local = safeJoin(projectPath, local);
  } else if (REMOTE_URL_RE.test(local)) {
    return null;
  }
  return local;
}

/** 定位源码片段（优先项目内相对路径，其次绝对路径） */
function readSnippet(file: string, line: number, projectPath?: string): string | undefined {
  const candidates = projectPath ? [safeJoin(projectPath, file), file] : [file];
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const content = fs.readFileSync(candidate, 'utf-8').split('\n');
      const snippet = content[line - 1]?.trim();
      if (snippet) return snippet;
    } catch {
      // 文件可能被占用或已删除
    }
  }
  return undefined;
}

/** 由文件路径推导模块名：src/modules/user/user.service.ts → user；src 根目录下取文件主干，否则取父目录名 */
const GENERIC_SOURCE_ROOTS = new Set(['src', 'lib', 'dist', 'build', 'out']);

export function deriveModule(file: string): string {
  const parts = file.replace(/\\/g, '/').split('/').filter(Boolean);
  const modulesIdx = parts.findIndex((p) => p === 'modules');
  if (modulesIdx !== -1 && modulesIdx + 1 < parts.length) return parts[modulesIdx + 1];
  if (parts.length >= 2) {
    const parent = parts[parts.length - 2];
    if (GENERIC_SOURCE_ROOTS.has(parent)) {
      return parts.at(-1)!.replace(EXTENSION_RE, '');
    }
    return parent;
  }
  return parts.at(-1)?.replace(EXTENSION_RE, '') ?? '';
}

/** 加载产物文件对应的 sourcemap（同级 .map 或文件尾部 sourceMappingURL 注释），失败返回 null */
function loadSourceMap(file: string, projectPath?: string): SourceMapData | null {
  const localPath = resolveLocalPath(file, projectPath);
  if (!localPath) return null;

  let raw: string | null = null;
  const siblingMap = `${localPath}.map`;
  try {
    if (fs.existsSync(siblingMap)) raw = fs.readFileSync(siblingMap, 'utf-8');
  } catch {
    // 读取失败则尝试 sourceMappingURL
  }

  if (raw === null) {
    try {
      if (!fs.existsSync(localPath)) return null;
      const content = fs.readFileSync(localPath, 'utf-8');
      const mappingMatch = SOURCE_MAPPING_URL_RE.exec(content.slice(-1000));
      if (!mappingMatch) return null;
      const mapPath = safeResolve(path.dirname(localPath), mappingMatch[1]);
      if (fs.existsSync(mapPath)) raw = fs.readFileSync(mapPath, 'utf-8');
    } catch {
      return null;
    }
  }

  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as SourceMapData;
    if (parsed.version === 3 && Array.isArray(parsed.sources)) return parsed;
  } catch {
    // 非法 sourcemap 内容按缺失处理
  }
  return null;
}

/** 用 sourcemap 将产物坐标反混淆回源文件坐标；无命中段返回 null */
export function locateWithSourceMap(frame: StackFrame, map: SourceMapData, projectPath?: string): SourceLocation | null {
  const segments = decodeMappings(map.mappings);
  const genLine = frame.line - 1;
  const genColumn = Math.max(0, frame.column - 1);

  let best: MappingSegment | null = null;
  for (const seg of segments) {
    if (seg.genLine !== genLine || seg.genColumn > genColumn) continue;
    if (!best || seg.genColumn >= best.genColumn) best = seg;
  }
  if (!best || best.sourceIndex >= map.sources.length) return null;

  const sourceRel = map.sources[best.sourceIndex];
  const file = (map.sourceRoot ? path.join(map.sourceRoot, sourceRel) : sourceRel).replace(/\\/g, '/');
  const line = best.originalLine + 1;
  const column = best.originalColumn + 1;
  const functionName = best.nameIndex !== undefined && map.names ? map.names[best.nameIndex] : frame.functionName;

  return {
    module: deriveModule(file),
    file,
    line,
    column,
    functionName,
    snippet: readSnippet(file, line, projectPath),
  };
}

/** 无 sourcemap 时回退粗定位：按堆栈文件 + 行号 + 项目内路径匹配 */
export function fallbackLocation(frame: StackFrame, projectPath?: string): SourceLocation {
  const local = resolveLocalPath(frame.file, projectPath) ?? frame.file;
  return {
    module: deriveModule(frame.file),
    file: frame.file,
    line: frame.line,
    column: frame.column,
    functionName: frame.functionName,
    snippet: readSnippet(local, frame.line, projectPath),
  };
}

/** 从崩溃堆栈中定位首个应用帧；优先 sourcemap 反混淆，缺失时回退粗定位 */
export function locateCrash(stack: string, options?: LocateOptions): SourceLocation | null {
  const projectPath = options?.projectPath;
  for (const frame of parseV8Stack(stack)) {
    if (frame.file.startsWith('node:') || frame.file.includes('node_modules')) continue;
    const map = loadSourceMap(frame.file, projectPath);
    if (map) {
      const located = locateWithSourceMap(frame, map, projectPath);
      if (located) return located;
    }
    return fallbackLocation(frame, projectPath);
  }
  return null;
}
