/**
 * 用户主动取消不得被当成失败（task-cancelled-silent.test.ts）
 *
 * 取消时 IPC 会把 `waitFor` 的 reject 透传到页面 catch。若不识别，
 * 用户点「停止」后会看到「体检失败 / 扫描失败」的红页 —— 把用户的主动操作
 * 报成系统故障，是最典型的一种说谎。
 */

import { describe, expect, it } from 'vitest';
import { initI18n } from '@zh/i18n';
import { isCancelledError, isCancelledMessage } from '../services/cancel-error';

// 「裸文案兼容」这条路要用到真实译文，先把语言固定成中文
initI18n({ lng: 'zh-Hans' });

describe('取消错误判据', () => {
  it('带标记的取消错误（主进程统一前缀）', () => {
    expect(isCancelledError(new Error('[cancelled] 任务已取消'))).toBe(true);
  });

  it('Electron IPC 包装后的错误也认得出来', () => {
    // Electron 会把远端错误改写成 "Error invoking remote method 'engine:runPipeline': Error: ..."
    expect(
      isCancelledError(
        new Error("Error invoking remote method 'engine:runPipeline': Error: [cancelled] 任务已取消"),
      ),
    ).toBe(true);
  });

  it('不带标记但含当前语言取消文案的旧路径也兼容', () => {
    expect(isCancelledMessage('任务已取消')).toBe(true);
  });

  it('真实错误不得被误判为取消', () => {
    for (const err of [
      new Error('spawn semgrep ENOENT'),
      new Error('任务执行失败'),
      new Error('[pipeline-host] 子进程异常退出'),
      new Error(''),
    ]) {
      expect(isCancelledError(err), `误判: ${err.message}`).toBe(false);
    }
  });

  it('非 Error 输入不抛异常也不误判', () => {
    for (const v of [null, undefined, {}, [], 42, true]) {
      expect(isCancelledError(v)).toBe(false);
    }
    expect(isCancelledError('任务被用户停止了')).toBe(false);
  });
});
