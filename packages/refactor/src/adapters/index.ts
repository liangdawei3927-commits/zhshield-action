import type { ParsedFile } from '../ast-helper';
import type { CodeSmell, RefactorConfig } from '../types';

import {
  detectLongMethod,
  detectLargeClass,
  detectLongParameterList,
  detectOversizedFile,
  detectOversizedComponent,
} from './scale-detectors';
import {
  detectDeepNesting,
  detectMixedResponsibilities,
  detectDuplicateCode,
  detectCallbackHell,
} from './structure-detectors';
import {
  detectFeatureEnvy,
  detectShotgunSurgery,
  detectDataClass,
  detectGodObject,
  detectDataClumps,
  detectPrimitiveObsession,
} from './coupling-detectors';
import {
  detectInappropriateIntimacy,
  detectMiddleMan,
  detectMessageChains,
  detectRefusedBequest,
  detectLazyClass,
  detectSwitchStatement,
} from './extra-detectors';

export interface DetectorSet {
  name: string;
  description: string;
  sopRuleId: string;
  detect: (parsed: ParsedFile, allFiles: ParsedFile[], config: RefactorConfig) => CodeSmell[];
}

export const ALL_DETECTORS: DetectorSet[] = [
  {
    name: 'long-method',
    description: '超大函数 (R01)',
    sopRuleId: 'refactor.R01',
    detect: (f, _, c) => detectLongMethod(f, c),
  },
  {
    name: 'oversized-file',
    description: '超大文件 (R02)',
    sopRuleId: 'refactor.R02',
    detect: (f, _, c) => detectOversizedFile(f, c),
  },
  {
    name: 'long-parameter-list',
    description: '过长参数 (R03)',
    sopRuleId: 'refactor.R03',
    detect: (f, _, c) => detectLongParameterList(f, c),
  },
  {
    name: 'mixed-responsibilities',
    description: '多职责混合 (R04)',
    sopRuleId: 'refactor.R04',
    detect: (f, _, c) => detectMixedResponsibilities(f, c),
  },
  {
    name: 'deep-nesting',
    description: '深层嵌套 (R05)',
    sopRuleId: 'refactor.R05',
    detect: (f, _, c) => detectDeepNesting(f, c),
  },
  {
    name: 'duplicated-code',
    description: '重复代码 (R06)',
    sopRuleId: 'refactor.R06',
    detect: (f, all, c) => detectDuplicateCode(f, all, c),
  },
  {
    name: 'callback-hell',
    description: '回调地狱 (R07)',
    sopRuleId: 'refactor.R07',
    detect: (f, _, c) => detectCallbackHell(f, c),
  },
  {
    name: 'shotgun-surgery',
    description: '霰弹修改 (R09)',
    sopRuleId: 'refactor.R09',
    detect: (f, all, c) => detectShotgunSurgery(f, all, c),
  },
  {
    name: 'data-class',
    description: '数据类 (R10)',
    sopRuleId: 'refactor.R10',
    detect: (f, _, c) => detectDataClass(f, c),
  },
  {
    name: 'oversized-component',
    description: '超大组件 (R11)',
    sopRuleId: 'refactor.R11',
    detect: (f, _, c) => detectOversizedComponent(f, c),
  },
  {
    name: 'god-object',
    description: '上帝对象 (R12)',
    sopRuleId: 'refactor.R12',
    detect: (f, _, c) => detectGodObject(f, c),
  },
  {
    name: 'large-class',
    description: '上帝对象/大类',
    sopRuleId: 'refactor.R12',
    detect: (f, _, c) => detectLargeClass(f, c),
  },
  {
    name: 'feature-envy',
    description: '依恋情结',
    sopRuleId: 'refactor.R08',
    detect: (f, _, c) => detectFeatureEnvy(f, c),
  },
  {
    name: 'inappropriate-intimacy',
    description: '不恰当的亲密',
    sopRuleId: 'refactor.R08',
    detect: (f, _, c) => detectInappropriateIntimacy(f, c),
  },
  {
    name: 'middle-man',
    description: '中间人',
    sopRuleId: 'refactor.R08',
    detect: (f, _, c) => detectMiddleMan(f, c),
  },
  {
    name: 'message-chains',
    description: '消息链',
    sopRuleId: 'refactor.R08',
    detect: (f, _, c) => detectMessageChains(f, c),
  },
  {
    name: 'refused-bequest',
    description: '拒绝继承',
    sopRuleId: 'refactor.R08',
    detect: (f, _, c) => detectRefusedBequest(f, c),
  },
  {
    name: 'lazy-class',
    description: '冗余类',
    sopRuleId: 'refactor.R10',
    detect: (f, _, c) => detectLazyClass(f, c),
  },
  {
    name: 'switch-statement',
    description: 'Switch 语句',
    sopRuleId: 'refactor.R08',
    detect: (f, _, c) => detectSwitchStatement(f, c),
  },
  {
    name: 'data-clumps',
    description: '数据泥团',
    sopRuleId: 'refactor.R03',
    detect: (f, _, c) => detectDataClumps(f, c),
  },
  {
    name: 'primitive-obsession',
    description: '基本类型偏执',
    sopRuleId: 'refactor.R10',
    detect: (f, _, c) => detectPrimitiveObsession(f, c),
  },
];
