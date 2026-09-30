/**
 * 硬超时保护：给 Promise 加单次执行上限，超时即以 reject 抛出携带 `timeoutMessage` 的 Error。
 *
 * inspect 的适配器执行器与 kernel 的 tool-dispatch 评估器此前各复制一份（jscpd 命中），
 * 仅超时文案前缀不同（`[inspect]` / `[sop]`），收敛为唯一实现，文案由调用方传入以保持不变。
 * 语义与原实现逐项一致：定时器在 resolve / reject 两条路径都 clearTimeout，原 Promise 的
 * 终态原样透传。
 */
export function withHardTimeout<T>(
  promise: Promise<T>,
  ms: number,
  timeoutMessage: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(timeoutMessage)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
