import { useEffect, useState } from 'react';

/**
 * 编译期注入的应用版本号（`vite.config.ts` / `vitest.config.ts` 的 `define`），
 * 来源是 `packages/desktop/package.json` 的 `version` —— 与 electron-builder 写入
 * Info.plist 的 `CFBundleShortVersionString`、运行时 `app.getVersion()` 同源。
 *
 * 声明写在本模块内而不是单独的 `.d.ts` 文件：.gitignore 把「packages 下 src 目录里的
 * .d.ts」当作「tsc 误输出到源码目录的陈旧产物」忽略，放独立文件会提交不上去，
 * 导致 CI 里 `__APP_VERSION__` 未声明而 typecheck 失败。
 */
declare const __APP_VERSION__: string;
function compileTimeVersion(): string {
  try {
    return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '';
  } catch {
    return '';
  }
}

/**
 * 应用版本号（形如 `0.2.0`，不含 `v` 前缀）。
 *
 * 两级取值，都是为了「显示值和安装包一致，且不用手改代码」：
 * 1. 首屏立即用编译期注入值 —— 与 electron-builder 写进 Info.plist 的版本同源，
 *    所以没有闪烁、也没有空档；
 * 2. 挂载后用 `app.getVersion()` 校正 —— 打包后它是运行中的真实版本，
 *    万一有人替换了 app 包内的 package.json，界面也以实际运行为准。
 *
 * @returns 版本字符串；无法取得时为 `''`（调用方应省略 `v` 后缀而不是显示 `v`）
 */
export function useAppVersion(): string {
  const [version, setVersion] = useState<string>(compileTimeVersion);

  useEffect(() => {
    // node 环境（服务端渲染 / 部分测试）没有 window，直接保留编译期值
    if (typeof window === 'undefined') return;
    const api = window.electronAPI;
    if (!api?.getAppInfo) return;

    let alive = true;
    api
      .getAppInfo()
      .then((info) => {
        // 只认非空字符串：主进程异常返回空值时不要把已显示的版本擦掉
        if (alive && typeof info?.version === 'string' && info.version !== '') {
          setVersion(info.version);
        }
      })
      .catch(() => {
        // 取不到就保留编译期值，不向用户暴露错误
      });

    return () => {
      alive = false;
    };
  }, []);

  return version;
}
