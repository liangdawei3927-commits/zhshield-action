import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * e2e 观测 IPC 的环境门控结构性守卫
 *
 * 背景：`ipc/e2e-observation.ts` 注册 5 个只服务于 e2e 的 handler，其中
 * `e2e:seedOrphanData` 会**真实写入用户数据库**、`e2e:setCachedProfile` 会改写缓存。
 * 一旦门控被删掉（或条件被放宽成恒真），渲染层任何 JS 都能污染用户数据，
 * 而 tsc / 常规单测都发现不了 —— 只有跑起打包后的 App 才可能暴露。
 *
 * 曾经的真实误判：只看 `e2e-observation.ts` 里的 `ipcMain.handle('e2e:...')`
 * 就断言"无环境守卫"，得出 P1 安全缺陷的结论。实际门控在 `main.ts` 的**调用处**。
 * 所以本测试断言的是**调用处**，不是注册处。
 */

const ELECTRON_DIR = path.resolve(__dirname, '../../electron');

function read(rel: string): string {
  return fs.readFileSync(path.join(ELECTRON_DIR, rel), 'utf-8');
}

/** 取出 `if (<cond>) { registerE2eObservationIpc(); }` 的条件表达式 */
function gateCondition(): string {
  const src = read('main.ts');
  const m = /if\s*\(([^)]*(?:\([^)]*\)[^)]*)*)\)\s*\{\s*registerE2eObservationIpc\(\);?/.exec(src);
  if (m === null) {
    throw new Error('main.ts 中未找到 registerE2eObservationIpc() 的条件门控 —— 门控被删除？');
  }
  return m[1] ?? '';
}

describe('e2e 观测 IPC — 生产不可达', () => {
  it('注册必须被 E2E=1 门控', () => {
    expect(gateCondition()).toContain("process.env.E2E === '1'");
  });

  it('注册必须同时被 !app.isPackaged 门控（打包态绝不注册）', () => {
    expect(gateCondition()).toMatch(/!\s*app\.isPackaged/);
  });

  it('注册点只有一个（不得在别处绕过门控直接调用）', () => {
    const hits = read('main.ts').match(/registerE2eObservationIpc\(\)/g) ?? [];
    expect(hits.length).toBe(1);
  });

  it('5 个 e2e handler 全部在函数内注册，不存在模块顶层副作用', () => {
    const src = read('ipc/e2e-observation.ts');
    const handles = src.match(/ipcMain\.handle\(/g) ?? [];
    expect(handles.length).toBe(5);
    // 顶层（行首无缩进）出现 ipcMain.handle 即为模块加载即注册，绕开一切门控
    expect(src).not.toMatch(/^ipcMain\.handle\(/m);
  });

  it('e2e 用例确实注入了 E2E=1（防止门控与用例口径漂移）', () => {
    const e2eDir = path.resolve(__dirname, '../../e2e');
    const specs = fs
      .readdirSync(e2eDir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'));
    const withE2e = specs.filter((f) =>
      /E2E:\s*'1'/.test(fs.readFileSync(path.join(e2eDir, f), 'utf-8')),
    );
    // 至少 app.spec.ts 需要它（删除全链用例依赖观测通道）
    expect(withE2e.length).toBeGreaterThan(0);
  });
});
