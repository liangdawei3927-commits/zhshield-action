import { execSync } from 'child_process';
import { EventCenter } from './event-center';
import type { SentinelEvent, EventStatus } from './types';

export interface AutoFixAction {
  type: 'restart-process' | 'rollback-commit' | 'run-script' | 'update-status';
  params: Record<string, string>;
}

export interface AutoFixRule {
  name: string;
  eventFilter: (event: SentinelEvent) => boolean;
  actions: AutoFixAction[];
  maxAttempts?: number;
}

export interface AutoFixerConfig {
  projectId: string;
  projectPath: string;
  rules: AutoFixRule[];
}

export class AutoFixer {
  private eventCenter: EventCenter;
  private config: AutoFixerConfig | null = null;
  private attemptCount = new Map<string, number>();
  private running = false;

  /** 动作类型 → 执行处理器策略表（替代 executeAction 中的 switch 分派） */
  private readonly actionHandlers: Partial<Record<AutoFixAction['type'], (action: AutoFixAction, event: SentinelEvent) => boolean>> = {
    'restart-process': (action) => {
      try {
        const processName = action.params.process || 'dev';
        execSync(`npx kill-port 3000 2>/dev/null; npm run ${processName} &`, {
          cwd: this.config?.projectPath,
          timeout: 10000,
          stdio: 'pipe',
        });
        return true;
      } catch {
        return false;
      }
    },
    'rollback-commit': (_action, event) => {
      try {
        const cwd = this.config?.projectPath;
        if (!cwd) return false;
        // Get the last commit hash for potential rollback
        execSync('git log --oneline -1', { cwd, timeout: 5000 });
        // Attempt a soft rollback (revert, not reset)
        execSync('git revert --no-commit HEAD~1..HEAD 2>/dev/null || true', { cwd, timeout: 15000 });
        this.eventCenter.createEvent({
          projectId: this.config!.projectId,
          title: 'Rollback executed',
          service: 'sentinel',
          module: 'auto-fixer',
          severity: 'p2',
          context: { eventId: event.id, action: 'rollback' },
          operator: 'auto-fixer',
          action: 'rollback-executed',
          detail: 'Automatic git revert applied to last commit',
        });
        return true;
      } catch {
        return false;
      }
    },
    'run-script': (action) => {
      try {
        const script = action.params.script;
        if (!script) return false;
        execSync(script, { cwd: this.config?.projectPath, timeout: 30000, stdio: 'pipe' });
        return true;
      } catch {
        return false;
      }
    },
    'update-status': (action, event) => {
      const targetStatus = action.params.status as EventStatus;
      if (targetStatus) {
        this.eventCenter.updateStatus(event.id, targetStatus, 'auto-fixer');
        return true;
      }
      return false;
    },
  };

  constructor(eventCenter: EventCenter) {
    this.eventCenter = eventCenter;
  }

  start(config: AutoFixerConfig): void {
    this.config = config;
    this.running = true;
  }

  stop(): void {
    this.running = false;
  }

  evaluateAndFix(event: SentinelEvent): boolean {
    if (!this.running || !this.config) return false;

    for (const rule of this.config.rules) {
      if (!rule.eventFilter(event)) continue;

      const outcome = this.processRule(rule, event);
      if (outcome === 'exhausted') return false;
      if (outcome === 'success') return true;
    }
    return false;
  }

  private processRule(rule: AutoFixRule, event: SentinelEvent): 'success' | 'continue' | 'exhausted' {
    const maxAttempts = rule.maxAttempts ?? 3;
    const attempts = this.attemptCount.get(event.dedupeKey) || 0;

    if (this.isAttemptExhausted(rule, event, attempts, maxAttempts)) {
      return 'exhausted';
    }

    return this.runRuleActions(rule, event, attempts);
  }

  private runRuleActions(rule: AutoFixRule, event: SentinelEvent, attempts: number): 'success' | 'continue' {
    this.attemptCount.set(event.dedupeKey, attempts + 1);
    this.eventCenter.updateStatus(event.id, 'fixing', 'auto-fixer');

    const allSucceeded = this.applyRuleActions(rule, event);
    this.emitFixOutcome(rule, event, allSucceeded, attempts);

    return allSucceeded ? 'success' : 'continue';
  }

  /** 尝试次数耗尽时标记失败并上报 */
  private isAttemptExhausted(
    rule: AutoFixRule,
    event: SentinelEvent,
    attempts: number,
    maxAttempts: number,
  ): boolean {
    if (attempts < maxAttempts) return false;

    this.eventCenter.updateStatus(event.id, 'failed', 'auto-fixer');
    this.eventCenter.createEvent({
      projectId: this.config!.projectId,
      title: `Auto-fix exhausted: ${rule.name}`,
      service: 'sentinel',
      module: 'auto-fixer',
      severity: 'p2',
      context: { rule: rule.name, eventId: event.id, attempts },
      operator: 'auto-fixer',
      action: 'fix-exhausted',
      detail: `Auto-fix rule "${rule.name}" exhausted after ${maxAttempts} attempts`,
    });
    return true;
  }

  /** 顺序执行规则的全部动作，全部成功才视为成功 */
  private applyRuleActions(rule: AutoFixRule, event: SentinelEvent): boolean {
    let allSucceeded = true;
    for (const action of rule.actions) {
      const ok = this.executeAction(action, event);
      if (!ok) allSucceeded = false;
    }
    return allSucceeded;
  }

  /** 按成败结果更新事件状态并上报结果事件 */
  private emitFixOutcome(rule: AutoFixRule, event: SentinelEvent, succeeded: boolean, attempts: number): void {
    const projectId = this.config!.projectId;
    if (succeeded) {
      this.eventCenter.updateStatus(event.id, 'pr_opened', 'auto-fixer');
      this.eventCenter.createEvent({
        projectId,
        title: `Auto-fix succeeded: ${rule.name}`,
        service: 'sentinel',
        module: 'auto-fixer',
        severity: 'p3',
        context: { rule: rule.name, eventId: event.id, actions: rule.actions.map((a) => a.type) },
        operator: 'auto-fixer',
        action: 'fix-succeeded',
        detail: `Auto-fix rule "${rule.name}" completed successfully`,
      });
      return;
    }

    this.eventCenter.updateStatus(event.id, 'failed', 'auto-fixer');
    this.eventCenter.createEvent({
      projectId,
      title: `Auto-fix failed: ${rule.name}`,
      service: 'sentinel',
      module: 'auto-fixer',
      severity: 'p2',
      context: { rule: rule.name, eventId: event.id },
      operator: 'auto-fixer',
      action: 'fix-failed',
      detail: `Auto-fix rule "${rule.name}" failed after ${attempts + 1} attempt(s)`,
    });
  }

  private executeAction(action: AutoFixAction, event: SentinelEvent): boolean {
    const handler = this.actionHandlers[action.type];
    return handler ? handler(action, event) : false;
  }
}
