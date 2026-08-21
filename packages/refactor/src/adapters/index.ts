import type { ParsedFile } from '../ast-helper';
import type { CodeSmell, RefactorConfig } from '../types';
import { translate, DEFAULT_LANGUAGE, type LanguageCode } from '@zh/i18n';

import { detectLongMethod, detectLargeClass, detectLongParameterList, detectOversizedFile, detectOversizedComponent } from './scale-detectors';
import { detectDeepNesting, detectMixedResponsibilities, detectDuplicateCode, detectCallbackHell } from './structure-detectors';
import { detectFeatureEnvy, detectShotgunSurgery, detectDataClass, detectGodObject, detectDataClumps, detectPrimitiveObsession } from './coupling-detectors';
import { detectInappropriateIntimacy, detectMiddleMan, detectMessageChains, detectRefusedBequest, detectLazyClass, detectSwitchStatement } from './extra-detectors';

export interface DetectorSet {
  name: string;
  description: string;
  sopRuleId: string;
  detect: (parsed: ParsedFile, allFiles: ParsedFile[], config: RefactorConfig, locale?: LanguageCode) => CodeSmell[];
}

export const ALL_DETECTORS: DetectorSet[] = [
  { name: 'long-method',            description: translate('engine.refactor.smell.long-method.name', DEFAULT_LANGUAGE),            sopRuleId: 'refactor.R01', detect: (f, _a, c, l) => detectLongMethod(f, c, l) },
  { name: 'oversized-file',         description: translate('engine.refactor.smell.oversized-file.name', DEFAULT_LANGUAGE),         sopRuleId: 'refactor.R02', detect: (f, _a, c, l) => detectOversizedFile(f, c, l) },
  { name: 'long-parameter-list',    description: translate('engine.refactor.smell.long-parameter-list.name', DEFAULT_LANGUAGE),    sopRuleId: 'refactor.R03', detect: (f, _a, c, l) => detectLongParameterList(f, c, l) },
  { name: 'mixed-responsibilities', description: translate('engine.refactor.smell.mixed-responsibilities.name', DEFAULT_LANGUAGE), sopRuleId: 'refactor.R04', detect: (f, _a, c, l) => detectMixedResponsibilities(f, c, l) },
  { name: 'deep-nesting',           description: translate('engine.refactor.smell.deep-nesting.name', DEFAULT_LANGUAGE),           sopRuleId: 'refactor.R05', detect: (f, _a, c, l) => detectDeepNesting(f, c, l) },
  { name: 'duplicated-code',        description: translate('engine.refactor.smell.duplicated-code.name', DEFAULT_LANGUAGE),        sopRuleId: 'refactor.R06', detect: (f, all, c, l) => detectDuplicateCode(f, all, c, l) },
  { name: 'callback-hell',          description: translate('engine.refactor.smell.callback-hell.name', DEFAULT_LANGUAGE),          sopRuleId: 'refactor.R07', detect: (f, _a, c, l) => detectCallbackHell(f, c, l) },
  { name: 'shotgun-surgery',        description: translate('engine.refactor.smell.shotgun-surgery.name', DEFAULT_LANGUAGE),        sopRuleId: 'refactor.R09', detect: (f, all, c, l) => detectShotgunSurgery(f, all, c, l) },
  { name: 'data-class',             description: translate('engine.refactor.smell.data-class.name', DEFAULT_LANGUAGE),             sopRuleId: 'refactor.R10', detect: (f, _a, c, l) => detectDataClass(f, c, l) },
  { name: 'oversized-component',    description: translate('engine.refactor.smell.oversized-component.name', DEFAULT_LANGUAGE),    sopRuleId: 'refactor.R11', detect: (f, _a, c, l) => detectOversizedComponent(f, c, l) },
  { name: 'god-object',             description: translate('engine.refactor.smell.god-object.name', DEFAULT_LANGUAGE),             sopRuleId: 'refactor.R12', detect: (f, _a, c, l) => detectGodObject(f, c, l) },
  { name: 'large-class',            description: translate('engine.refactor.smell.large-class.name', DEFAULT_LANGUAGE),            sopRuleId: 'refactor.R12', detect: (f, _a, c, l) => detectLargeClass(f, c, l) },
  { name: 'feature-envy',           description: translate('engine.refactor.smell.feature-envy.name', DEFAULT_LANGUAGE),           sopRuleId: 'refactor.R08', detect: (f, _a, c, l) => detectFeatureEnvy(f, c, l) },
  { name: 'inappropriate-intimacy', description: translate('engine.refactor.smell.inappropriate-intimacy.name', DEFAULT_LANGUAGE), sopRuleId: 'refactor.R08', detect: (f, _a, c, l) => detectInappropriateIntimacy(f, c, l) },
  { name: 'middle-man',             description: translate('engine.refactor.smell.middle-man.name', DEFAULT_LANGUAGE),             sopRuleId: 'refactor.R08', detect: (f, _a, c, l) => detectMiddleMan(f, c, l) },
  { name: 'message-chains',         description: translate('engine.refactor.smell.message-chains.name', DEFAULT_LANGUAGE),         sopRuleId: 'refactor.R08', detect: (f, _a, c, l) => detectMessageChains(f, c, l) },
  { name: 'refused-bequest',        description: translate('engine.refactor.smell.refused-bequest.name', DEFAULT_LANGUAGE),        sopRuleId: 'refactor.R08', detect: (f, _a, c, l) => detectRefusedBequest(f, c, l) },
  { name: 'lazy-class',             description: translate('engine.refactor.smell.lazy-class.name', DEFAULT_LANGUAGE),             sopRuleId: 'refactor.R10', detect: (f, _a, c, l) => detectLazyClass(f, c, l) },
  { name: 'switch-statement',       description: translate('engine.refactor.smell.switch-statement.name', DEFAULT_LANGUAGE),       sopRuleId: 'refactor.R08', detect: (f, _a, c, l) => detectSwitchStatement(f, c, l) },
  { name: 'data-clumps',            description: translate('engine.refactor.smell.data-clumps.name', DEFAULT_LANGUAGE),            sopRuleId: 'refactor.R03', detect: (f, _a, c, l) => detectDataClumps(f, c, l) },
  { name: 'primitive-obsession',    description: translate('engine.refactor.smell.primitive-obsession.name', DEFAULT_LANGUAGE),    sopRuleId: 'refactor.R10', detect: (f, _a, c, l) => detectPrimitiveObsession(f, c, l) },
];
