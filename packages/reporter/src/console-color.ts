const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const MAGENTA = '\x1b[35m';
const GRAY = '\x1b[90m';
const DIM = '\x1b[2m';

/**
 * ConsoleColor — 终端 ANSI 颜色工具（本包唯一实现）
 *
 * 关闭颜色时所有方法原样返回输入，保证管道输出纯净。
 *
 * `color` 为公开只读字段：ConsoleReporter 系列（sections）直接用 `fmt.color`
 * 判断是否着色，故不能继续私有化。
 */
export class ConsoleColor {
  readonly color: boolean;

  constructor(color: boolean) {
    this.color = color;
  }

  bold(s: string): string {
    return this.color ? `${BOLD}${s}${RESET}` : s;
  }

  red(s: string): string {
    return this.color ? `${RED}${s}${RESET}` : s;
  }

  green(s: string): string {
    return this.color ? `${GREEN}${s}${RESET}` : s;
  }

  yellow(s: string): string {
    return this.color ? `${YELLOW}${s}${RESET}` : s;
  }

  cyan(s: string): string {
    return this.color ? `${CYAN}${s}${RESET}` : s;
  }

  magenta(s: string): string {
    return this.color ? `${MAGENTA}${s}${RESET}` : s;
  }

  gray(s: string): string {
    return this.color ? `${GRAY}${s}${RESET}` : s;
  }

  dim(s: string): string {
    return this.color ? `${DIM}${s}${RESET}` : s;
  }

  header(text: string): string {
    return this.color ? `${BOLD}${CYAN}${text}${RESET}` : `== ${text} ==`;
  }
}
