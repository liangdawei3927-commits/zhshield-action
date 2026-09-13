// 植入问题3：类型错误（tsc 应检出 TS2322）
// 植入问题4：未使用变量（eslint 应检出）
const unusedVar: string = "hello";
const n: number = "not a number";
export function greet(name: string): string {
  return "hi " + name;
}
