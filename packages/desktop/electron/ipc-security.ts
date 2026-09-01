/**
 * IPC sender 来源校验（安全加固）：
 * 所有 ipcMain.handle / ipcMain.on 的调用方必须来自应用自身页面
 * （开发模式 = Vite dev server 源；生产模式 = file:// 打包产物）。
 *
 * 实现方式：在 main.ts 注册任何 handler 之前对 ipcMain.handle / ipcMain.on
 * 做一次性统一包装（单点强制），新增 handler 无需逐个调用即可获得防护。
 * 来源不匹配时抛错，渲染进程收到 rejected promise / error 事件。
 */

import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';

/** 开发模式 dev server URL（与 ipc-context 同源读取，避免测试环境牵入 app.getPath 顶层调用） */
const DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL'];

/** 判断 sender frame URL 是否来自应用自身 */
export function isTrustedSenderFrame(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (DEV_SERVER_URL) {
      // 开发模式：仅允许 Vite dev server 源（origin 比较，忽略路径差异）
      return parsed.origin === new URL(DEV_SERVER_URL).origin;
    }
    // 生产模式：loadFile 加载打包产物，页面协议为 file://
    return parsed.protocol === 'file:';
  } catch {
    return false;
  }
}

/** 校验 IPC 事件来源；不信任时抛错（fail-closed） */
export function assertTrustedSender(event: IpcMainEvent | IpcMainInvokeEvent): void {
  const url = event.senderFrame?.url ?? '';
  if (!isTrustedSenderFrame(url)) {
    throw new Error(`Untrusted IPC sender: ${url || '(empty frame url)'}`);
  }
}

/** 在注册任何 handler 之前调用一次，统一包装 ipcMain.handle / ipcMain.on */
export function enforceTrustedIpcSender(): void {
  const ipc = ipcMain as unknown as {
    handle: (
      channel: string,
      listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
    ) => unknown;
    on: (channel: string, listener: (event: IpcMainEvent, ...args: unknown[]) => void) => unknown;
  };

  const origHandle = ipc.handle.bind(ipcMain) as typeof ipc.handle;
  ipc.handle = ((
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
  ) =>
    origHandle(channel, (event, ...args) => {
      assertTrustedSender(event);
      return listener(event, ...args);
    })) as typeof ipc.handle;

  const origOn = ipc.on.bind(ipcMain) as typeof ipc.on;
  ipc.on = ((channel: string, listener: (event: IpcMainEvent, ...args: unknown[]) => void) =>
    origOn(channel, (event, ...args) => {
      assertTrustedSender(event);
      return listener(event, ...args);
    })) as typeof ipc.on;
}
