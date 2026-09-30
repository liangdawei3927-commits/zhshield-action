import type { InspectionReportData } from '../types/electron';
import { useT } from '../i18n';
import { STATUS_CONFIG } from './inspect-logic';
import { ResultCard } from '../components/ui/ResultCard';
import { CopyToAiButton } from '../components/ui/CopyToAiButton';
import { CopyAllToAiButton } from '../components/ui/CopyAllToAiButton';

export function ProgressBar({ passCount, total }: { passCount: number; total: number }) {
  const t = useT();
  return (
    <ResultCard variant="score" className="flex items-center gap-6 mb-6">
      <div className="text-center">
        <div className="text-3xl font-bold text-success-700">
          {passCount}/{total}
        </div>
        <div className="text-xs text-zh-muted mt-1">{t('page.inspect.checksPassed')}</div>
      </div>
      <div className="flex-1 h-2.5 rounded-full bg-zh-panel">
        <div
          className="h-full rounded-full bg-gradient-to-r from-success-600 to-success-700 transition-all"
          style={{ width: `${total ? (passCount / total) * 100 : 0}%` }}
        />
      </div>
    </ResultCard>
  );
}

export function CheckList({
  items,
  onCopyToAi,
  onCopyAll,
}: {
  items: InspectionReportData['checks'];
  onCopyToAi: (item: InspectionReportData['checks'][number]) => void;
  onCopyAll: (items: InspectionReportData['checks']) => void;
}) {
  const t = useT();
  const failedCount = items.filter((i) => i.status !== 'pass').length;
  return (
    <ResultCard variant="list" className="overflow-hidden">
      {failedCount > 0 && (
        <div className="flex items-center justify-between px-5 py-3 border-b border-zh-line">
          <span className="text-xs text-zh-muted">
            {t('page.inspect.copyAllPrompt', { count: failedCount })}
          </span>
          <CopyAllToAiButton onClick={() => onCopyAll(items)} />
        </div>
      )}
      {items.map((item, i) => {
        const config = STATUS_CONFIG[item.status] ?? STATUS_CONFIG.fail;
        return (
          <div
            key={item.id}
            className="flex items-center gap-4 px-5 py-4"
            style={{
              borderBottom: i < items.length - 1 ? '1px solid rgb(var(--zh-line))' : 'none',
            }}
          >
            <div
              className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold"
              style={{ background: config.bg, color: config.color }}
            >
              {config.icon}
            </div>
            <div className="flex-1">
              {/* 「AI 深度审查」徽章已删除（09-19）：原判据 `item.source === 'ai-code-review'` 恒为假
                  —— 唯一数据源 toInspectionReportDataFromRuleEngine 产出的 checks 不含 source 字段，
                  且 AiCodeReviewImpl.deepReview 只在已废弃的直扫分支调用，SOP 巡检不执行 AI 审查。
                  留一个永不出现的承诺比没有更糟。若将来恢复 AI 审查，需同时：①SOP 映射补 source
                  ②本处重新渲染 ③i18n 五语言补回 page.inspect.aiReviewBadge。 */}
              <span className="text-sm font-medium text-zh-ink-2">{item.name}</span>
              <div className="text-xs mt-0.5 text-zh-muted">{item.detail}</div>
            </div>
            {item.status !== 'pass' && <CopyToAiButton onClick={() => onCopyToAi(item)} />}
            <span
              className="text-xs px-2 py-0.5 rounded font-medium"
              style={{ background: config.bg, color: config.color }}
            >
              {t(config.labelKey)}
            </span>
          </div>
        );
      })}
    </ResultCard>
  );
}
