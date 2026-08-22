/**
 * 极简 YAML 子集解析器（从 ToolsConfigLoader 私有实现提取为独立模块，供多个包复用）。
 *
 * 支持：嵌套映射（缩进驱动）、标量（boolean / number / string / null）、`- ` 数组项。
 * 不支持：多行字符串块以外的复杂 YAML 特性（锚点、流式语法等）。
 */

const INDENT_PATTERN = /\S/;
const NUMERIC_KEY = /^\d+$/;

/** 解析简单 YAML 内容为嵌套 Record 结构 */
export function parseSimpleYaml(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const stack: { indent: number; key: string; obj: Record<string, unknown> }[] = [];

  for (const line of content.split('\n')) {
    parseYamlLine(line, result, stack);
  }

  return cleanArrays(result);
}

/** 解析单行 YAML 并维护容器栈 */
function parseYamlLine(
  line: string,
  result: Record<string, unknown>,
  stack: { indent: number; key: string; obj: Record<string, unknown> }[],
): void {
  if (!line.trim() || line.trim().startsWith('#')) return;

  const indent = line.search(INDENT_PATTERN);
  const trimmed = line.trim();

  const colonIdx = trimmed.indexOf(':');
  if (colonIdx === -1) return;

  const key = trimmed.slice(0, colonIdx).trim();
  const value = trimmed.slice(colonIdx + 1).trim();

  while (stack.length > 0 && stack.at(-1)!.indent >= indent) {
    stack.pop();
  }

  const currentObj = stack.length > 0 ? stack.at(-1)!.obj : result;

  if (value === '' || value === '|' || value === '>') {
    pushContainer(stack, currentObj, key, indent);
  } else if (key.startsWith('- ')) {
    pushArrayItem(currentObj, key, value);
  } else {
    currentObj[key] = parseScalar(value);
  }
}

function pushContainer(
  stack: { indent: number; key: string; obj: Record<string, unknown> }[],
  parent: Record<string, unknown>,
  key: string,
  indent: number,
): Record<string, unknown> {
  const newObj: Record<string, unknown> = {};
  if (key.startsWith('- ')) {
    const arr = (parent._array || (parent._array = [])) as unknown[];
    const item: Record<string, unknown> = {};
    arr.push(item);
    stack.push({ indent, key, obj: item });
    return item;
  }
  parent[key] = newObj;
  stack.push({ indent, key, obj: newObj });
  return newObj;
}

function pushArrayItem(currentObj: Record<string, unknown>, key: string, value: string): void {
  const cleanKey = key.slice(2);
  let arr = currentObj[cleanKey] as unknown[];
  if (!Array.isArray(arr)) {
    arr = [];
    currentObj[cleanKey] = arr;
  }
  arr.push(parseScalar(value));
}

function parseScalar(value: string): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  const num = Number(value);
  if (!isNaN(num) && value.trim() !== '') return num;
  return value.replace(/^['"]|['"]$/g, '');
}

function cleanArrays(obj: Record<string, unknown>): Record<string, unknown> {
  if (obj._array) {
    const arr = obj._array as unknown[];
    delete obj._array;
    for (const item of arr) {
      cleanArrays(item as Record<string, unknown>);
    }
    return arr as unknown as Record<string, unknown>;
  }

  const keys = Object.keys(obj);
  if (keys.length === 1 && NUMERIC_KEY.test(keys[0])) {
    return obj;
  }

  for (const key of keys) {
    cleanValue(obj[key]);
  }
  return obj;
}

function cleanValue(val: unknown): void {
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    cleanArrays(val as Record<string, unknown>);
    return;
  }
  if (Array.isArray(val)) {
    for (const item of val) {
      if (item && typeof item === 'object') {
        cleanArrays(item as Record<string, unknown>);
      }
    }
  }
}
