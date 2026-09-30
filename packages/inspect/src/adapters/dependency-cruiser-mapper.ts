/**
 * dependency-cruiser-mapper.ts — dep-cruiser JSON 输出 → 统一 Issue 映射
 *
 * 自 DependencyCruiserAdapter 抽出（zhcheck large-class 治理）：适配器只负责
 * 命令解析、执行与错误上报，输出解析 / 严重级映射 / 指纹生成归本模块。
 */
import { randomUUID } from 'node:crypto';
import type { Issue } from '@zh/shared';

/** Dependency-cruiser JSON 输出中的单条违规。
 *  v16+ 的 from/to 为字符串路径；旧版接口可能为 { path, line } 对象。 */
export interface DepCruiserNodeRef {
  path?: string;
  line?: number;
}

/** dependency-cruiser 报告的单条违规：命中规则（含严重级别）与违规边（from → to） */
export interface DepCruiserViolation {
  rule?: { name?: string; severity?: string };
  from?: string | DepCruiserNodeRef;
  to?: string | DepCruiserNodeRef;
}

/** Dependency-cruiser JSON 输出结构 */
export interface DepCruiserOutput {
  summary?: { violations?: DepCruiserViolation[] };
}

/** 解析 dep-cruiser JSON 输出的 violations 段并映射为 Issue 列表 */
export function mapDepCruiserOutput(output: unknown): Issue[] {
  const out = output as DepCruiserOutput;
  if (!out?.summary?.violations || !Array.isArray(out.summary.violations)) return [];
  return out.summary.violations.map((v) => mapViolationToIssue(v));
}

function mapViolationToIssue(v: DepCruiserViolation): Issue {
  const fromPath = nodeRefPath(v.from);
  const toPath = nodeRefPath(v.to);
  return {
    id: randomUUID(),
    ruleId: v.rule?.name || 'dep-cruiser/violation',
    severity: mapSeverity(v.rule?.severity),
    category: 'architecture',
    message: buildViolationMessage(v),
    file: fromPath,
    line: nodeRefLine(v.from),
    column: 0,
    suggestion: `模块 ${fromPath} 不应引用 ${toPath}`,
    autoFixable: false,
    source: 'inspect',
    fingerprint: buildViolationFingerprint(v),
  };
}

function nodeRefPath(ref: string | DepCruiserNodeRef | undefined): string {
  if (typeof ref === 'string') return ref;
  return ref?.path || '';
}

function nodeRefLine(ref: string | DepCruiserNodeRef | undefined): number {
  if (typeof ref === 'string') return 0;
  return ref?.line || 0;
}

function mapSeverity(severity: string | undefined): Issue['severity'] {
  return severity === 'error' ? 'error' : severity === 'warn' ? 'warning' : 'info';
}

function buildViolationMessage(v: DepCruiserViolation): string {
  return `架构边界违规: ${v.rule?.name || '未知规则'} - ${nodeRefPath(v.from) || '?'} → ${nodeRefPath(v.to) || '?'}`;
}

function buildViolationFingerprint(v: DepCruiserViolation): string {
  return `dep-cruiser:${v.rule?.name || ''}:${nodeRefPath(v.from)}:${nodeRefPath(v.to)}`;
}
