/**
 * 用户原话：「所有按钮点击停止后按钮下面会有一行红色的字提示任务已取消，
 * 这行提示字不需要，帮我彻底删除」。
 *
 * 2026-10-26 用户截图实锤：红字是 **`[cancelled] 任务已取消`（带标记的原始错误
 * 消息，不是 i18n 文案）**，标题是「体检失败」⇒ 走 failure 分支而非 catch 分支。
 * 真凶是主进程 handler 把取消吞成"失败结果"（详见 cancel-not-swallowed.test.ts）。
 *
 * 本文件锁住**渲染层**这半条链：取消一旦到达渲染层，绝不能变成失败态/红字。
 * 四道锁：
 *   1. 映射器锁：`toInspectOutcome` 必须把取消判成 'cancelled'，不得判 'failed'；
 *   2. 消费端锁：`inspect-logic` 必须先处理 'cancelled' 再处理 'failed'；
 *   3. 接缝锁：主进程每个可取消 handler 的 catch 都必须调 `rethrowIfCancelled`
 *      （漏一个，那个域就会把用户的取消说成故障）；
 *   4. 渲染面锁：界面任何地方都不得渲染「任务已取消」文案。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../i18n';
import { DomainEmptyView } from '../components/business/DomainEmptyView';
import { toInspectOutcome } from '../pages/inspect-sop-mapper';

const SRC = resolve(__dirname, '..');
const DESKTOP = resolve(SRC, '..');
const read = (rel: string): string => readFileSync(resolve(SRC, rel), 'utf8');
const readDesktop = (rel: string): string => readFileSync(resolve(DESKTOP, rel), 'utf8');

/** 主进程写进 reject 消息的取消消息（带 ASCII 标记） */
const CANCELLED_MESSAGE = '[cancelled] 任务已取消';

/** 递归收集 src 下所有 .ts/.tsx（排除测试、i18n 定义、node_modules、类型声明） */
function collect(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === '__tests__' || name === 'i18n' || name === 'node_modules') continue;
      collect(p, acc);
    } else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts')) {
      acc.push(p);
    }
  }
  return acc;
}

/**
 * 取出源文件里某个具名函数的完整函数体（按大括号配平，不用正则猜边界）。
 *
 * ⚠️ 起点必须是**参数表右括号之后**的 `{`：参数表里可能自带花括号（如
 * `options?: { dryRun?: boolean }`），从第一个 `{` 开始配平会提前收口。
 * 字符串里带不平衡大括号仍会失准 —— 本文件涉及的这几个 handler 没有这种字面量。
 */
function functionBody(src: string, name: string): string {
  const start = src.search(new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`));
  if (start < 0) return '';
  // 先配平参数表，找到函数体的起始大括号
  let parenDepth = 0;
  let bodyStart = -1;
  for (let i = src.indexOf('(', start); i < src.length; i++) {
    const c = src[i];
    if (c === '(') parenDepth++;
    else if (c === ')') {
      parenDepth--;
      if (parenDepth === 0) {
        bodyStart = src.indexOf('{', i);
        break;
      }
    }
  }
  if (bodyStart < 0) return '';
  let depth = 0;
  for (let i = bodyStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return '';
}

beforeAll(() => {
  // node 环境无 localStorage，I18nProvider 退回 navigator.language；固定成中文
  vi.stubGlobal('navigator', { language: 'zh-Hans-CN' });
});

/** 渲染取消后的实际状态：任务已取消 → useTaskRun 返回 idle → 空态壳 loading=false */
function renderIdleEmptyView(): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <DomainEmptyView
        projectPath="/tmp/proj"
        dimension="quality"
        title="质量巡检"
        subtitle="subtitle"
        features={[{ icon: <span />, title: 'a', desc: 'b' }]}
        buttonText="一键体检"
        onAction={() => undefined}
        actionDomain="inspect"
        loading={false}
      />
    </I18nProvider>,
  );
}

describe('锁 1：映射器必须把取消判成 cancelled，不得判 failed', () => {
  it('error 是取消消息 → cancelled 态（不是 failed）', () => {
    const outcome = toInspectOutcome({ error: CANCELLED_MESSAGE });
    expect(outcome.kind, '取消被判成失败 ⇒ 会渲染「体检失败」+ 红字').toBe('cancelled');
    expect(outcome.kind === 'failed' ? outcome.detail : '').not.toContain(CANCELLED_MESSAGE);
  });

  it('真实故障仍是 failed 态（不能把真故障也吞成取消）', () => {
    const outcome = toInspectOutcome({ error: 'semgrep ENOENT' });
    expect(outcome.kind).toBe('failed');
    expect(outcome.kind === 'failed' ? outcome.detail : '').toContain('semgrep ENOENT');
  });

  it('无 error 的正常载荷不会被判成取消', () => {
    expect(toInspectOutcome({ error: null }).kind).not.toBe('cancelled');
  });
});

describe('锁 2：消费端必须先处理 cancelled 再处理 failed', () => {
  it('inspect-logic 在 failed 分支之前处理 cancelled', () => {
    const src = read('pages/inspect-logic.ts');
    const cancelledIdx = src.indexOf("outcome.kind === 'cancelled'");
    const failedIdx = src.indexOf("outcome.kind === 'failed'");
    expect(cancelledIdx, 'inspect-logic 没处理 cancelled 态').toBeGreaterThan(-1);
    expect(failedIdx, 'inspect-logic 没了 failed 分支（实现变了请同步更新门禁）').toBeGreaterThan(-1);
    expect(cancelledIdx, 'cancelled 必须排在 failed 之前，否则取消会先落失败页').toBeLessThan(
      failedIdx,
    );
  });
});

describe('锁 3：主进程每个可取消 handler 都必须短路取消', () => {
  const HANDLERS: [file: string, fn: string][] = [
    ['electron/ipc/engines.ts', 'runPipelineHandler'],
    ['electron/ipc/engines.ts', 'runGuardHandler'],
    ['electron/ipc/engines.ts', 'runGarbageScanHandler'],
    ['electron/ipc/engines.ts', 'runPerformanceHandler'],
    ['electron/ipc/engines-scanners.ts', 'runSecurityHandler'],
    ['electron/ipc/engines-scanners.ts', 'garbageCleanHandler'],
    ['electron/ipc/engines-scanners.ts', 'garbageRestoreHandler'],
  ];

  for (const [file, fn] of HANDLERS) {
    it(`${file} 的 ${fn} 在 catch 里调 rethrowIfCancelled`, () => {
      const body = functionBody(readDesktop(file), fn);
      expect(body, `在 ${file} 里找不到 ${fn}`).not.toBe('');
      expect(
        body.includes('rethrowIfCancelled'),
        `${fn} 的 catch 没短路取消 ⇒ 用户点停止会被说成失败（还会顶出红色错误文案）`,
      ).toBe(true);
    });
  }

  it('取消判据与标记同源（主进程与渲染层用同一字面量）', () => {
    const main = readDesktop('electron/pipeline-protocol.ts');
    const renderer = read('services/cancel-error.ts');
    expect(main).toContain("export const CANCELLED_ERR_TAG = '[cancelled]'");
    expect(renderer).toContain("export const CANCELLED_ERR_TAG = '[cancelled]'");
    expect(main).toMatch(/export\s+function\s+rethrowIfCancelled/);
    expect(main).toMatch(/export\s+function\s+isCancelledFailure/);
  });
});

describe('锁 4：界面不存在「任务已取消」的渲染点', () => {
  it('空态壳（取消后的实际状态 = idle）渲染不含该红字', () => {
    const html = renderIdleEmptyView();
    expect(html, '按钮下方出现了「任务已取消」红字').not.toContain('任务已取消');
  });

  it('没有任何组件渲染 t(\'task.cancelled\') 或硬编码「任务已取消」', () => {
    const files = collect(SRC);
    expect(files.length, '扫描范围自证：src 文件数').toBeGreaterThan(50);

    const allowed = (f: string) =>
      f.endsWith('services/cancel-error.ts') || // 取消识别服务：只识别标记，不渲染
      f.includes('/__tests__/') || // 测试文件里的断言串允许出现
      f.includes('/i18n/') || // i18n 键定义允许出现
      f.endsWith('.json'); // 语言包允许出现

    const offenders = files
      .filter((f) => !allowed(f))
      .filter((f) => {
        const c = readFileSync(f, 'utf8');
        return /t\(\s*['"]task\.cancelled['"]\s*\)/.test(c) || c.includes('任务已取消');
      });

    expect(
      offenders.map((f) => f.replace(SRC, '')),
      '这些文件把「任务已取消」渲染到了界面上',
    ).toEqual([]);
  });
});

/** 兜底：取消识别服务本身必须仍然存在且导出 isCancelledError（否则上面的锁会失去前提） */
describe('取消识别服务前提仍在', () => {
  it('services/cancel-error.ts 存在并导出 isCancelledError', () => {
    const p = resolve(SRC, 'services/cancel-error.ts');
    expect(existsSync(p)).toBe(true);
    expect(readFileSync(p, 'utf8')).toMatch(/export\s+(function|const)\s+isCancelledError/);
  });
});
