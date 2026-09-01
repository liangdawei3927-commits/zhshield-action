/**
 * 误报反馈 IPC（ipc/feedback.ts）
 *
 * 门禁 / 哨兵发现的问题标记为误报时，落盘到
 * <project>/.zhshield/false-positives.jsonl（JSONL，与 guard-reports.jsonl 同目录约定）。
 * 数据后续由云端大脑（智汇大脑）同步消费，用于规则质量校准，因此本地不展示规则来源与内部细节。
 */

import { ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { t } from '@zh/i18n';
import { getEvolve } from '../ipc-context';

/** 前端提交的误报反馈条目（不携带来源细节，仅问题定位信息） */
export interface FalsePositiveFeedbackItem {
  source: 'guard' | 'sentinel';
  /** 规则 / 检查项 / 事件类型的标识 */
  ruleId: string;
  /** 展示名（检查项名或事件标题） */
  title?: string;
  message: string;
  severity?: string;
  file?: string;
  line?: number;
}

/** 落库记录：反馈条目 + 定位信息 */
export interface FalsePositiveFeedbackRecord extends FalsePositiveFeedbackItem {
  id: string;
  timestamp: string;
}

const FEEDBACK_FILE = 'false-positives.jsonl';
const MAX_RECORDS = 200;

export function falsePositivesPath(projectPath: string): string {
  return join(projectPath, '.zhshield', FEEDBACK_FILE);
}

/** 追加一条误报反馈，返回落盘绝对路径；写入失败静默（不阻断用户主流程） */
export async function appendFalsePositive(
  projectPath: string,
  item: FalsePositiveFeedbackItem,
): Promise<string> {
  const record: FalsePositiveFeedbackRecord = {
    ...item,
    id: randomUUID(),
    timestamp: new Date().toISOString(),
  };
  const absPath = falsePositivesPath(projectPath);
  await mkdir(join(projectPath, '.zhshield'), { recursive: true });
  await appendFile(absPath, `${JSON.stringify(record)}\n`, 'utf-8');
  await trimToLimit(absPath);
  return absPath;
}

/** 文件超过上限时截断，只保留最近 MAX_RECORDS 条 */
async function trimToLimit(absPath: string): Promise<void> {
  try {
    const lines = (await readFile(absPath, 'utf-8')).split('\n').filter(Boolean);
    if (lines.length <= MAX_RECORDS) return;
    await writeFile(absPath, `${lines.slice(-MAX_RECORDS).join('\n')}\n`, 'utf-8');
  } catch {
    // 截断失败不影响主流程
  }
}

/**
 * 误报反馈同步写入演进引擎经验池（type=false-positive）并重算规则权重。
 * 供「规则进化 / 架构分析」页积累真实数据；失败静默，不阻断反馈主流程。
 */
async function recordFeedbackExperience(
  projectPath: string,
  item: FalsePositiveFeedbackItem,
): Promise<void> {
  try {
    const evolve = await getEvolve();
    evolve.recordExperience({
      projectId: projectPath,
      ruleId: item.ruleId,
      type: 'false-positive',
      pattern: item.title ?? item.ruleId,
      message: item.message,
      feedback: item.message,
      source: 'user',
      confidence: 0.8,
      verified: false,
    });
    evolve.autoAdjustWeights();
  } catch {
    // 经验回写失败不影响误报反馈主流程
  }
}

/** 读取误报反馈记录（按 source 过滤，最近在前）；文件不存在返回空数组，损坏行跳过 */
export async function listFalsePositives(
  projectPath: string,
  source?: 'guard' | 'sentinel',
): Promise<FalsePositiveFeedbackRecord[]> {
  const absPath = falsePositivesPath(projectPath);
  let content: string;
  try {
    content = await readFile(absPath, 'utf-8');
  } catch {
    return [];
  }
  const records: FalsePositiveFeedbackRecord[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as FalsePositiveFeedbackRecord);
    } catch {
      // 损坏行跳过，不影响其余记录
    }
  }
  return records.filter((record) => !source || record.source === source).reverse();
}

export function registerFeedbackIpc(): void {
  ipcMain.handle(
    'feedback:reportFalsePositive',
    async (
      _event,
      projectPath: string,
      item: FalsePositiveFeedbackItem,
    ): Promise<{ ok: boolean; id?: string; reason?: string }> => {
      if (!projectPath || typeof projectPath !== 'string') {
        return { ok: false, reason: t('electron.invalidProjectPath') };
      }
      if (!item || typeof item !== 'object' || !item.ruleId || !item.message) {
        return { ok: false, reason: t('electron.feedbackIncomplete') };
      }
      try {
        const absPath = await appendFalsePositive(projectPath, item);
        await recordFeedbackExperience(projectPath, item);
        const lines = (await readFile(absPath, 'utf-8')).split('\n').filter(Boolean);
        const record = lines.pop();
        return {
          ok: true,
          id: record ? (JSON.parse(record) as FalsePositiveFeedbackRecord).id : undefined,
        };
      } catch {
        return { ok: false, reason: t('electron.writeFailed') };
      }
    },
  );

  ipcMain.handle(
    'feedback:listFalsePositives',
    async (
      _event,
      projectPath: string,
      source?: 'guard' | 'sentinel',
    ): Promise<FalsePositiveFeedbackRecord[]> => {
      if (!projectPath || typeof projectPath !== 'string') return [];
      return listFalsePositives(projectPath, source);
    },
  );
}
