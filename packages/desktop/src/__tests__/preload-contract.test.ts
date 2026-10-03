import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * preload 桥接面契约测试：类型声明（src/types/electron.d.ts 的 ElectronAPI）
 * 与 preload.ts 实际暴露的对象必须逐项对齐。
 *
 * 存在原因（2026-10-02）：`engine.depsRelockBaseline` 在 electron.d.ts:501 有声明、
 * 在 electron/ipc/engines.ts:482 有 handler，但 preload 从未桥接，渲染层
 * engineApi.ts:293 调用即抛 `is not a function` —— 类型检查与单测双双放过。
 * 同名旧用例 preload.test.ts 断言的是自己刚构造的 mock 字面量，
 * 从不加载真实 preload，因此结构上不可能发现此类缺口（自证式断言）。
 * 本用例改为加载真实 preload 并与类型契约比对，使该类缺口可被回归拦截。
 */
const exposed = new Map<string, Record<string, unknown>>();

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, api: Record<string, unknown>) => {
      exposed.set(key, api);
    },
  },
  ipcRenderer: {
    invoke: vi.fn(),
    on: vi.fn(),
    send: vi.fn(),
    removeListener: vi.fn(),
  },
}));

await import('../../electron/preload');

const here = dirname(fileURLToPath(import.meta.url));
const dts = readFileSync(resolve(here, '../types/electron.d.ts'), 'utf8');

/** 取指定 interface 的花括号体（按深度配对，避免嵌套 interface / 泛型误切） */
function interfaceBody(name: string): string {
  const decl = dts.search(new RegExp(`\\binterface\\s+${name}\\s*\\{`));
  if (decl < 0) throw new Error(`electron.d.ts 中找不到 interface ${name}`);
  const open = dts.indexOf('{', decl);
  let depth = 0;
  for (let i = open; i < dts.length; i++) {
    if (dts[i] === '{') depth++;
    else if (dts[i] === '}' && --depth === 0) return dts.slice(open + 1, i);
  }
  throw new Error(`interface ${name} 花括号未闭合`);
}

/**
 * 按深度 0 切分成员声明。
 *
 * 只把 () {} [] 计入配对：`.d.ts` 里箭头函数 `=>` 的 `>` 极常见，若把 `<`/`>`
 * 当泛型括号配对，每个箭头都会把深度减 1，切分随即错位。对象字面量类型内部的
 * `;` 由 `{}` 单独即可护住，无需依赖尖括号。
 */
function topLevelMembers(body: string): string[] {
  const members: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of body) {
    if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') depth--;
    if (depth === 0 && ch === ';') {
      members.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) members.push(current);
  return members;
}

/** 展开嵌套 *API 接口，产出形如 'engine.runGuard' 的叶子路径 */
function collectLeafPaths(iface: string, prefix: string[] = [], out: string[] = []): string[] {
  for (const raw of topLevelMembers(interfaceBody(iface))) {
    const decl = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').trim();
    const m = decl.match(/^(\w+)\??\s*:\s*([\s\S]+)$/);
    if (!m) continue;
    const [, name, type] = m;
    if (/^[A-Z]\w*API$/.test(type)) collectLeafPaths(type, [...prefix, name], out);
    else out.push([...prefix, name].join('.'));
  }
  return out;
}

const declaredPaths = collectLeafPaths('ElectronAPI', [], []);

describe('preload 桥接面契约（electron.d.ts ↔ preload.ts）', () => {
  it('ElectronAPI 契约非空（解析器未失效）', () => {
    expect(declaredPaths.length).toBeGreaterThan(50);
  });

  it('真实 preload 通过 contextBridge 暴露了 electronAPI', () => {
    expect(exposed.has('electronAPI')).toBe(true);
  });

  it.each(declaredPaths)('类型声明的 electronAPI.%s 在 preload 中确有桥接', (path) => {
    const api = exposed.get('electronAPI')!;
    let cursor: unknown = api;
    for (const segment of path.split('.')) {
      expect(
        cursor,
        `electronAPI.${path} 在 ${segment} 段断裂：preload 未暴露该层`,
      ).toBeTypeOf('object');
      cursor = (cursor as Record<string, unknown>)[segment];
    }
    expect(cursor, `electronAPI.${path} 缺失：类型已声明但 preload 未桥接`).toBeDefined();
  });
});