// 打印 turbo --concurrency 的整数值，供根 package.json 的 build/dev/lint 脚本注入。
// 逻辑镜像 packages/shared/src/machine-profile.ts 的 turboConcurrency（低配 1，否则 cores 封顶 4），
// 但根 node_modules/@zh 只链接 kernel 而非 shared，故此处内联等价逻辑而非 import。
// 用法：node scripts/turbo-concurrency.mjs
import * as os from 'node:os';

const clamp = (n, min, max) => Math.min(Math.max(n, min), max);

const envRaw = process.env.ZH_TURBO_CONCURRENCY;
const envMax = envRaw ? Number.parseInt(envRaw, 10) : Number.NaN;

let concurrency;
if (Number.isFinite(envMax)) {
  concurrency = clamp(envMax, 1, 4);
} else if (os.totalmem() <= 8 * 1024 ** 3) {
  concurrency = 1;
} else {
  concurrency = clamp(os.cpus().length, 2, 4);
}

process.stdout.write(String(concurrency));
