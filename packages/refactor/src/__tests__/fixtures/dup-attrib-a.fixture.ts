// fixture: sharedCalc 位于本文件第 4 行起（10 行）；dup-attrib-b 中位于第 8 行起
// 回归目标：duplicated-code 行号必须归属当前侧（旧实现两侧都取 lines[0]）
const PREAMBLE_A = 1;
export function sharedCalc(start: number, step: number): number {
  const base = start * 10;
  const adjust = step > 0 ? step : -step;
  const clamped = adjust > 100 ? 100 : adjust;
  const total = base + clamped;
  const rounded = Math.round(total / 5) * 5;
  const sign = total < 0 ? '-' : '+';
  const value = sign === '-' ? -rounded : rounded;
  return value;
}
export function tailA(flag: boolean): number {
  return flag ? 1 : 2;
}