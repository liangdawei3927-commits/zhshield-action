import { bFunc } from './b';
// 植入问题2：a -> b -> a 循环依赖（dependency-cruiser 应检出）
export function aFunc(): number {
  return bFunc() + 1;
}
export function unusedFn(): void {}
