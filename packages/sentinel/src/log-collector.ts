import * as fs from 'fs';
import * as path from 'path';
import { EventCenter } from './event-center';
import { locateCrash } from './stack-locator';
import type { SourceLocation } from './stack-locator';

export interface LogPattern {
  name: string;
  regex: RegExp;
  severity: 'p1' | 'p2' | 'p3';
}

export interface LogCollectorConfig {
  projectId: string;
  logPaths: string[];
  projectPath?: string;
  patterns?: LogPattern[];
  pollIntervalMs?: number;
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

interface PendingCrash {
  projectId: string;
  logPath: string;
  projectPath?: string;
  line: string;
  pattern: LogPattern;
  stackLines: string[];
}

const STACK_FRAME_RE = /^\s+at\s/;

export class LogCollector {
  private eventCenter: EventCenter;
  private fileSizes = new Map<string, number>();
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  private running = false;
  private patterns: LogPattern[];
  private pendingCrash: PendingCrash | null = null;
  private logProjects = new Map<string, string>();

  constructor(eventCenter: EventCenter, customPatterns?: LogPattern[]) {
    this.eventCenter = eventCenter;
    this.patterns = customPatterns && customPatterns.length > 0 ? customPatterns : DEFAULT_PATTERNS;
  }

  start(config: LogCollectorConfig): void {
    this.running = true;
    const interval = config.pollIntervalMs || 3000;

    for (const logPath of config.logPaths) {
      if (!this.startLogPath(config, logPath, interval)) {
        console.warn(`[LogCollector] Log path does not exist, skipping: ${logPath}`);
      }
    }
  }

  /** 初始化单个日志文件的监听（记录大小并抓取初始尾部） */
  private startLogPath(config: LogCollectorConfig, logPath: string, intervalMs: number): boolean {
    if (!fs.existsSync(logPath)) return false;

    const stat = fs.statSync(logPath);
    this.fileSizes.set(logPath, stat.size);
    if (config.projectPath) this.logProjects.set(logPath, config.projectPath);
    this.tailInitial(config.projectId, logPath);
    this.watchLog(config.projectId, logPath, intervalMs);
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

  private watchLog(projectId: string, logPath: string, intervalMs: number): void {
    const timer = setInterval(() => {
      if (!this.running) return;
      this.tailNew(projectId, logPath);
    }, intervalMs);
    this.timers.set(logPath, timer);
  }

  private tailInitial(projectId: string, logPath: string): void {
    try {
      const content = fs.readFileSync(logPath, 'utf-8');
      const lines = content.split('\n');
      // Only scan last 200 lines on initial load to avoid flooding
      const tailLines = lines.slice(-200);
      for (const line of tailLines) {
        this.checkLine(projectId, logPath, line);
      }
      this.flushPendingCrash();
    } catch {
      // File may be binary or locked
    }
  }

  private tailNew(projectId: string, logPath: string): void {
    try {
      const stat = fs.statSync(logPath);
      const previousSize = this.fileSizes.get(logPath) || 0;
      const currentSize = stat.size;
      if (currentSize < previousSize) {
        this.handleLogRotation(projectId, logPath, currentSize);
        return;
      }
      if (currentSize === previousSize) return;
      const content = this.readNewBytes(logPath, previousSize, currentSize);
      if (content === null) return;
      this.processLines(projectId, logPath, content);
      this.fileSizes.set(logPath, currentSize);
    } catch {
      // File may be temporarily inaccessible
    }
  }

  /** 日志被轮转/截断：重置记录大小并重新抓取初始尾部 */
  private handleLogRotation(projectId: string, logPath: string, currentSize: number): void {
    this.fileSizes.set(logPath, currentSize);
    this.tailInitial(projectId, logPath);
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

  private processLines(projectId: string, logPath: string, content: string): void {
    const lines = content.split('\n');
    for (const line of lines) {
      this.checkLine(projectId, logPath, line);
    }
    this.flushPendingCrash();
  }

  private checkLine(projectId: string, logPath: string, line: string): void {
    if (!line.trim()) return;

    if (STACK_FRAME_RE.test(line)) {
      if (this.pendingCrash) this.pendingCrash.stackLines.push(line.trimEnd());
      return;
    }

    if (this.pendingCrash) this.flushPendingCrash();

    const pattern = this.findMatchingPattern(line);
    if (!pattern) return;
    if (pattern.severity === 'p1') {
      this.pendingCrash = {
        projectId,
        logPath,
        projectPath: this.logProjects.get(logPath),
        line,
        pattern,
        stackLines: [],
      };
      return;
    }
    this.emitLogMatch(projectId, logPath, line, pattern);
  }

  private flushPendingCrash(): void {
    const pending = this.pendingCrash;
    this.pendingCrash = null;
    if (!pending) return;
    if (pending.stackLines.length === 0) {
      this.emitLogMatch(pending.projectId, pending.logPath, pending.line, pending.pattern);
      return;
    }
    const stack = pending.stackLines.join('\n');
    const location = locateCrash(stack, { projectPath: pending.projectPath });
    this.emitLogMatch(pending.projectId, pending.logPath, pending.line, pending.pattern, { stack, location });
  }

  private findMatchingPattern(line: string): LogPattern | null {
    for (const pattern of this.patterns) {
      if (pattern.regex.test(line)) return pattern;
    }
    return null;
  }

  private emitLogMatch(
    projectId: string,
    logPath: string,
    line: string,
    pattern: LogPattern,
    extra?: { stack: string; location: SourceLocation | null },
  ): void {
    const relativePath = path.relative(process.cwd(), logPath);
    const context: Record<string, unknown> = {
      pattern: pattern.name,
      logFile: relativePath,
      matchedLine: line.slice(0, 300),
    };
    if (extra?.stack) context.stack = extra.stack;
    if (extra?.location) context.location = extra.location;
    this.eventCenter.createEvent({
      projectId,
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
}
