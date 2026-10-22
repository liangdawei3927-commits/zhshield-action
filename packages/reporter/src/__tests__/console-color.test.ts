import { describe, it, expect } from 'vitest';
import { ConsoleColor } from '../console-color';

// ConsoleColor 是 i18n 注入层格式化器的着色工具。--no-color 的承诺是
// 「管道输出纯净」：关闭颜色后所有方法必须原样返回输入，
// CI 日志、重定向文件、非 TTY 终端不得混入任何 ANSI 转义码。

describe('ConsoleColor — 终端颜色开关语义', () => {
  it('enabled=true 时文本被对应 ANSI 颜色码包裹', () => {
    const c = new ConsoleColor(true);
    expect(c.red('err')).toBe('\x1b[31merr\x1b[0m');
    expect(c.green('ok')).toBe('\x1b[32mok\x1b[0m');
    expect(c.yellow('warn')).toBe('\x1b[33mwarn\x1b[0m');
    expect(c.bold('b')).toBe('\x1b[1mb\x1b[0m');
    expect(c.dim('d')).toBe('\x1b[2md\x1b[0m');
    expect(c.gray('g')).toBe('\x1b[90mg\x1b[0m');
    expect(c.cyan('c')).toBe('\x1b[36mc\x1b[0m');
    expect(c.magenta('m')).toBe('\x1b[35mm\x1b[0m');
  });

  it('enabled=false 时所有方法原样返回输入——转义码混进管道会污染下游 grep/归档', () => {
    const c = new ConsoleColor(false);
    expect(c.red('err')).toBe('err');
    expect(c.green('ok')).toBe('ok');
    expect(c.yellow('warn')).toBe('warn');
    expect(c.bold('b')).toBe('b');
    expect(c.dim('d')).toBe('d');
    expect(c.gray('g')).toBe('g');
    expect(c.cyan('c')).toBe('c');
    expect(c.magenta('m')).toBe('m');
    expect(c.red('x')).not.toContain('\x1b');
  });

  it('header 在无色模式下降级为「== 文本 ==」包裹——非 TTY 终端仍需可辨识的标题分隔', () => {
    const colored = new ConsoleColor(true);
    const plain = new ConsoleColor(false);

    expect(colored.header('报告')).toBe('\x1b[1m\x1b[36m报告\x1b[0m');
    expect(plain.header('报告')).toBe('== 报告 ==');
  });
});
