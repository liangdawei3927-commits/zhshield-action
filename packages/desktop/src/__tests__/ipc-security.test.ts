import { describe, it, expect, vi } from 'vitest';

/**
 * IPC sender 来源校验回归：
 * 业务意义 —— 若渲染进程出现 XSS（恶意 iframe / 被注入页面），非应用来源的
 * frame 不得调用任何 IPC handler（fail-closed）；应用自身页面必须正常放行，
 * 否则会阻断全部桌面功能。
 */
describe('ipc-security sender 校验', () => {
  it('开发模式：同源（Vite dev server）放行，外部 http/file 来源拒绝', async () => {
    vi.stubEnv('VITE_DEV_SERVER_URL', 'http://localhost:5173');
    const { isTrustedSenderFrame } = await import('../../electron/ipc-security');

    // 应用自身页面（dev server，含路由路径）→ 放行
    expect(isTrustedSenderFrame('http://localhost:5173/index.html')).toBe(true);
    expect(isTrustedSenderFrame('http://localhost:5173/')).toBe(true);
    // 外部页面 iframe → 拒绝
    expect(isTrustedSenderFrame('http://evil.example.com/index.html')).toBe(false);
    // 跨协议来源 → 拒绝
    expect(isTrustedSenderFrame('file:///app/index.html')).toBe(false);
    // 非法 URL → 拒绝（fail-closed）
    expect(isTrustedSenderFrame('not a url')).toBe(false);
  });

  it('生产模式：file:// 打包产物放行，http(s) 来源拒绝，空 frame 拒绝', async () => {
    vi.stubEnv('VITE_DEV_SERVER_URL', '');
    vi.resetModules();
    const { assertTrustedSender } = await import('../../electron/ipc-security');

    // 打包页面 → 放行
    expect(
      assertTrustedSender({
        senderFrame: { url: 'file:///Applications/app.asar/dist/index.html' },
      } as never),
    ).toBeUndefined();
    // 被劫持 iframe（远程页面）→ 抛错
    expect(() =>
      assertTrustedSender({ senderFrame: { url: 'https://evil.example.com/' } } as never),
    ).toThrow(/Untrusted IPC sender/);
    // senderFrame 已销毁 / URL 为空 → 抛错（fail-closed）
    expect(() => assertTrustedSender({ senderFrame: null } as never)).toThrow(
      /Untrusted IPC sender/,
    );
  });

  it('wrap 语义：enforceTrustedIpcSender 包装后，可信来源正常执行，不可信来源 handler 不被调用', async () => {
    vi.stubEnv('VITE_DEV_SERVER_URL', '');
    vi.resetModules();
    await import('../../electron/ipc-security');

    // 模拟 ipcMain 单例：handle/on 记录注册的 listener，便于直接触发验证
    type Listener = (event: unknown, ...args: unknown[]) => unknown;
    const handlers = new Map<string, Listener>();
    const fakeIpc = {
      handle: vi.fn((channel: string, listener: Listener) =>
        handlers.set(`h:${channel}`, listener),
      ),
      on: vi.fn((channel: string, listener: Listener) => handlers.set(`o:${channel}`, listener)),
    };
    vi.doMock('electron', () => ({ ipcMain: fakeIpc }));
    vi.resetModules();
    const mod = await import('../../electron/ipc-security');
    mod.enforceTrustedIpcSender();

    // 包装生效：注册后 listener 被记录（handle/on 均被替换为校验版本）
    fakeIpc.handle('update:check', () => 'ok');
    fakeIpc.on('window:minimize', () => 'ok');
    expect(handlers.get('h:update:check')).toBeTypeOf('function');
    expect(handlers.get('o:window:minimize')).toBeTypeOf('function');

    const invokeListener = handlers.get('h:update:check')!;
    const onListener = handlers.get('o:window:minimize')!;

    // 可信来源（file://）→ handler 正常返回
    const trusted = { senderFrame: { url: 'file:///app.asar/dist/index.html' } };
    expect(invokeListener(trusted)).toBe('ok');
    expect(onListener(trusted)).toBe('ok');
    // 不可信来源（https）→ 抛错，handler 逻辑不执行
    const untrusted = { senderFrame: { url: 'https://evil.example.com/' } };
    expect(() => invokeListener(untrusted)).toThrow(/Untrusted IPC sender/);
    expect(() => onListener(untrusted)).toThrow(/Untrusted IPC sender/);
  });
});
