import { useT } from '../i18n';
import { ResultCard } from '../components/ui/ResultCard';
import { SectionTitle } from '../components/ui/SectionTitle';
import { SectionIcon } from '../components/ui/Icons';
import { DEBT_CATEGORY_CONFIG, DEBT_CATEGORY_ORDER } from './tech-debt-logic';

/** 债务构成介绍卡片：5 类债务的图标 + 名称 + 简介 */
export function TechDebtCompositionIntroCard() {
  const t = useT();
  return (
    <ResultCard variant="score" className="mt-6">
      <SectionTitle
        icon={
          <SectionIcon>
            <circle cx="12" cy="12" r="10" />
            <path d="M12 16v-4M12 8h.01" />
          </SectionIcon>
        }
        label={t('page.techdebt.intro.title')}
      />
      <div className="grid grid-cols-2 gap-x-8 gap-y-4">
        {DEBT_CATEGORY_ORDER.map((cat) => {
          const cfg = DEBT_CATEGORY_CONFIG[cat] ?? DEBT_CATEGORY_CONFIG.duplication;
          return (
            <div key={cat} className="flex items-start gap-3">
              <span
                className="mt-1 w-2.5 h-2.5 rounded-full shrink-0"
                style={{ background: cfg.color }}
              />
              <div className="min-w-0">
                <div className="text-sm font-semibold text-zh-ink-2">{t(cfg.labelKey)}</div>
                <div className="text-xs text-zh-muted mt-0.5 leading-relaxed">
                  {t(`page.techdebt.categoryDesc.${cat}`)}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </ResultCard>
  );
}
