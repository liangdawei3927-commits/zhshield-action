import * as fs from 'fs';
import * as path from 'path';
import { EventCenter } from './event-center';
import { locateCrash, type SourceLocation } from './stack-locator';

export interface LogPattern {
  name: string;
  regex: RegExp;
  severity: 'p1' | 'p2' | 'p3';
}

export interface LogCollectorConfig {
  projectId: string;
  logPaths: string[];
  patterns?: LogPattern[];
  pollIntervalMs?: number;
  /** 项目根目录：用于 sourcemap 反混淆与源码片段读取 */
  projectPath?: string;
}

interface LogTarget {
  projectId: string;
  logPath: string;
}

const DEFAULT_PATTERNS: LogPattern[] = [
  { name: 'uncaught-exception', regex: /uncaughtException|unhandledRejection/i, severity: 'p1' },
  { name: 'crash', regex: /FATAL|CRASH|SEGFAULT|abort|signal/i, severity: 'p1' },
  { name: 'out-of-memory', regex: /heap out of memory|ALLOC_FAILED|ENOMEM/i, severity: 'p1' },
  { name: '5xx-http', regex: /"status":5\d{2}|"code":5\d{2}|HTTP.*5\d{2}/i, severity: 'p2' },
  { name: 'request-error', regex: /Error|error|Exception|exception/i, severity: 'p2' },
  { name: 'warning', regex: /Warning|warning|WARN/i, severity: 'p3' },
  { name: 'timeout', regex: /timeout|Timed out|ETIMEDOUT/i, severity: 'p2' },
  { name: 'refused', regex: /ECONNREFUSED|connection refused|ConnectionRefused/i, severity: 'p2' },
];

/** 堆栈帧行：`    at function (file:line:col)` */
const STACK_FRAME_LINE_RE = /^\s*at\s+/i;

export class LogCollector {
  private eventCenter: EventCenter;
  private fileSizes = new Map<string, number>();
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  private running = false;
  private patterns: LogPattern[];
  private projectPath: string | null = null;

  constructor(eventCenter: EventCenter, customPatterns?: LogPattern[]) {
    this.eventCenter = eventCenter;
    this.patterns = customPatterns && customPatterns.length > 0 ? customPatterns : DEFAULT_PATTERNS;
  }

  start(config: LogCollectorConfig): void {
    this.running = true;
    this.projectPath = config.projectPath ?? null;
    const interval = config.pollIntervalMs || 3000;

    for (const logPath of config.logPaths) {
      if (!this.startLogPath({ projectId: config.projectId, logPath }, interval)) {
        console.warn(`[LogCollector] Log path does not exist, skipping: ${logPath}`);
      }
    }
  }

  /** 初始化单个日志文件的监听（记录大小并抓取初始尾部） */
  private startLogPath(target: LogTarget, intervalMs: number): boolean {
    if (!fs.existsSync(target.logPath)) return false;

    const stat = fs.statSync(target.logPath);
    this.fileSizes.set(target.logPath, stat.size);
    this.tailInitial(target);
    this.watchLog(target, intervalMs);
    return true;
  }

  stop(): void {
    this.running = false;
    for (const [, timer] of this.timers) {
      clearInterval(timer);
    }
    this.timers.clear();
    this.fileSizes.clear();
  }

  private watchLog(target: LogTarget, intervalMs: number): void {
    const timer = setInterval(() => {
      if (!this.running) return;
      this.tailNew(target);
    }, intervalMs);
    this.timers.set(target.logPath, timer);
  }

  private tailInitial(target: LogTarget): void {
    try {
      const content = fs.readFileSync(target.logPath, 'utf-8');
      const lines = content.split('\n');
      // Only scan last 200 lines on initial load to avoid flooding
      this.scanLines(target, lines.slice(-200));
    } catch {
      // File may be binary or locked
    }
  }

  private tailNew(target: LogTarget): void {
    const currentSize = this.readCurrentSize(target.logPath);
    if (currentSize === null) return;

    this.processSizeDelta(target, currentSize);
  }

  private processSizeDelta(target: LogTarget, currentSize: number): void {
    const previousSize = this.fileSizes.get(target.logPath) || 0;

    if (currentSize < previousSize) {
      this.handleLogRotation(target, currentSize);
      return;
    }

    if (currentSize === previousSize) return;

    this.consumeNewBytes(target, previousSize, currentSize);
  }

  private readCurrentSize(logPath: string): number | null {
    try {
      return fs.statSync(logPath).size;
    } catch {
      // File may be temporarily inaccessible
      return null;
    }
  }

  private handleLogRotation(target: LogTarget, currentSize: number): void {
    this.fileSizes.set(target.logPath, currentSize);
    this.tailInitial(target);
  }

  private consumeNewBytes(target: LogTarget, previousSize: number, currentSize: number): void {
    const content = this.readNewBytes(target.logPath, previousSize, currentSize);
    if (content === null) return;
    this.processLines(target, content);
    this.fileSizes.set(target.logPath, currentSize);
  }

  /** 读取自上次大小以来的新字节（上限 1MB） */
  private readNewBytes(logPath: string, previousSize: number, currentSize: number): string | null {
    const length = currentSize - previousSize;
    // Cap read size to prevent memory issues with huge log files
    const safeLength = Math.min(length, 1024 * 1024); // Max 1MB per poll
    const startPos = previousSize;

    try {
      const fd = fs.openSync(logPath, 'r');
      const buffer = Buffer.alloc(safeLength);
      fs.readSync(fd, buffer, 0, safeLength, startPos);
      fs.closeSync(fd);
      return buffer.toString('utf-8');
    } catch {
      return null;
    }
  }

  private processLines(target: LogTarget, content: string): void {
    this.scanLines(target, content.split('\n'));
  }

  private scanLines(target: LogTarget, lines: string[]): void {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;

      const pattern = this.findMatchingPattern(line);
      if (!pattern) continue;

      if (pattern.severity === 'p1') {
        const frames = this.collectStackFrames(lines, i);
        this.emitLogMatch(target, line, pattern, frames);
        i += frames.length;
      } else {
        this.emitLogMatch(target, line, pattern);
      }
    }
  }

  private collectStackFrames(lines: string[], startIndex: number): string[] {
    const frames: string[] = [];
    for (let j = startIndex + 1; j < lines.length && frames.length < 20; j++) {
      const next = lines[j];
      if (STACK_FRAME_LINE_RE.test(next)) {
        frames.push(next.trim());
      } else if (next.trim() === '') {
        continue;
      } else {
        break;
      }
    }
    return frames;
  }

  private findMatchingPattern(line: string): LogPattern | null {
    for (const pattern of this.patterns) {
      if (pattern.regex.test(line)) return pattern;
    }
    return null;
  }

  private emitLogMatch(target: LogTarget, line: string, pattern: LogPattern, stackFrames: string[] = []): void {
    const relativePath = path.relative(process.cwd(), target.logPath);
    const context: Record<string, unknown> = {
      pattern: pattern.name,
      logFile: relativePath,
      matchedLine: line.slice(0, 300),
    };

    if (stackFrames.length > 0) {
      const stack = [line, ...stackFrames].join('\n').slice(0, 4000);
      context.stack = stack;
      const location = this.locateStack(stack);
      if (location) context.location = location;
    }

    this.eventCenter.createEvent({
      projectId: target.projectId,
      title: `Log match: ${pattern.name}`,
      service: 'sentinel',
      module: 'log-collector',
      severity: pattern.severity,
      context,
      operator: 'log-collector',
      action: 'log-pattern-matched',
      detail: `[${pattern.name}] ${relativePath}: ${line.slice(0, 200)}`,
    });
  }

  private locateStack(stackText: string): SourceLocation | null {
    try {
      return locateCrash(stackText, { projectPath: this.projectPath ?? undefined });
    } catch {
      return null;
    }
  }
}
