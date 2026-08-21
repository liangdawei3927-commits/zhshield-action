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
 * ConsoleColor — 终端 ANSI 颜色工具
 *
 * 关闭颜色时所有方法原样返回输入，保证管道输出纯净
 */
export class ConsoleColor {
  private enabled: boolean;

  constructor(enabled: boolean) {
    this.enabled = enabled;
  }

  bold(s: string): string {
    return this.enabled ? `${BOLD}${s}${RESET}` : s;
  }

  red(s: string): string {
    return this.enabled ? `${RED}${s}${RESET}` : s;
  }

  green(s: string): string {
    return this.enabled ? `${GREEN}${s}${RESET}` : s;
  }

  yellow(s: string): string {
    return this.enabled ? `${YELLOW}${s}${RESET}` : s;
  }

  cyan(s: string): string {
    return this.enabled ? `${CYAN}${s}${RESET}` : s;
  }

  magenta(s: string): string {
    return this.enabled ? `${MAGENTA}${s}${RESET}` : s;
  }

  gray(s: string): string {
    return this.enabled ? `${GRAY}${s}${RESET}` : s;
  }

  dim(s: string): string {
    return this.enabled ? `${DIM}${s}${RESET}` : s;
  }

  header(text: string): string {
    return this.enabled ? `${BOLD}${CYAN}${text}${RESET}` : `== ${text} ==`;
  }
}
