/**
 * 能力引用计数账本纯函数单测（capability-refs.test.ts）
 *
 * R2 能力引用计数回收（06 §3.3 + §6.1/§6.2）验收 1/2：
 *   1. 账本三态：claim 幂等 / release 后 refs 空 → reclaiming + since / 再次 claim → 唤醒
 *   2. 共享能力不误伤：A/B 两项目删 A → eslint.refs=['B'] 且 status 保持 active
 * 全部用 mkdtempSync tmpDir + afterEach rmSync，绝不写真实 ~/.zhshield 与真实 os.homedir。
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  capabilityIdOf,
  claimToolRefs,
  claimSopModuleRefs,
  defaultCapabilityRefsPath,
  deriveProjectId,
  getReclaimingToolIds,
  loadCapabilityRefs,
  markReclaimed,
  markSopModulesReclaimed,
  releaseProjectRefs,
  saveCapabilityRefs,
  sopModuleIdOf,
  splitResolvedTools,
  type CapabilityRefs,
} from '../../electron/capability-refs';
import { isToolLanguagesMatch } from '@zh/shared';

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zh-capability-refs-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** 构造一个含 toolrule:eslint 且 refs=[A,B] 的账本 */
function refsWithSharedEslint(): CapabilityRefs {
  return {
    schemaVersion: 1,
    capabilities: {
      [capabilityIdOf('eslint')]: { languages: [], refs: ['A', 'B'], status: 'active' },
    },
  };
}

describe('claimToolRefs 幂等（验收 1）', () => {
  it('同 projectId 两次 claim refs 不重复', () => {
    const base: CapabilityRefs = { schemaVersion: 1, capabilities: {} };
    const once = claimToolRefs(base, 'proj-A', ['eslint']);
    const twice = claimToolRefs(once, 'proj-A', ['eslint']);
    expect(twice.capabilities[capabilityIdOf('eslint')].refs).toEqual(['proj-A']);
  });

  it('不同 projectId 各自入 refs', () => {
    const base: CapabilityRefs = { schemaVersion: 1, capabilities: {} };
    const a = claimToolRefs(base, 'proj-A', ['eslint']);
    const ab = claimToolRefs(a, 'proj-B', ['eslint']);
    expect(ab.capabilities[capabilityIdOf('eslint')].refs).toEqual(['proj-A', 'proj-B']);
  });

  it('返回新对象，不原地改输入', () => {
    const base: CapabilityRefs = { schemaVersion: 1, capabilities: {} };
    const result = claimToolRefs(base, 'proj-A', ['eslint']);
    expect(result).not.toBe(base);
    expect(base.capabilities).toEqual({});
  });
});

describe('releaseProjectRefs 空集标记（验收 1）', () => {
  it('release 后 refs 空 → status reclaiming + since 为数值', () => {
    const base: CapabilityRefs = {
      schemaVersion: 1,
      capabilities: {
        [capabilityIdOf('eslint')]: { languages: [], refs: ['A'], status: 'active' },
      },
    };
    const released = releaseProjectRefs(base, 'A');
    const entry = released.capabilities[capabilityIdOf('eslint')];
    expect(entry.refs).toEqual([]);
    expect(entry.status).toBe('reclaiming');
    expect(typeof entry.since).toBe('number');
  });

  it('共享能力不误伤：A/B 删 A → eslint.refs=[B] 且 status 仍 active（验收 2）', () => {
    const released = releaseProjectRefs(refsWithSharedEslint(), 'A');
    const entry = released.capabilities[capabilityIdOf('eslint')];
    expect(entry.refs).toEqual(['B']);
    expect(entry.status).toBe('active');
    expect(entry.since).toBeUndefined();
  });

  it('再删 B → refs 空 → reclaiming（验收 2 收尾）', () => {
    const afterA = releaseProjectRefs(refsWithSharedEslint(), 'A');
    const afterB = releaseProjectRefs(afterA, 'B');
    const entry = afterB.capabilities[capabilityIdOf('eslint')];
    expect(entry.refs).toEqual([]);
    expect(entry.status).toBe('reclaiming');
  });

  it('通用遍历：sop-module:* 键同样移除 projectId 并标记 reclaiming', () => {
    const base: CapabilityRefs = {
      schemaVersion: 1,
      capabilities: {
        'sop-module:typescript': { languages: ['typescript'], refs: ['A'], status: 'active' },
      },
    };
    const released = releaseProjectRefs(base, 'A');
    const entry = released.capabilities['sop-module:typescript'];
    expect(entry.refs).toEqual([]);
    expect(entry.status).toBe('reclaiming');
  });
});

describe('唤醒（验收 1）', () => {
  it('reclaiming 能力被再次 claim → status active 且 since 字段消失', () => {
    const reclaiming: CapabilityRefs = {
      schemaVersion: 1,
      capabilities: {
        [capabilityIdOf('eslint')]: {
          languages: [],
          refs: [],
          status: 'reclaiming',
          since: 1759747200000,
        },
      },
    };
    const claimed = claimToolRefs(reclaiming, 'proj-A', ['eslint']);
    const entry = claimed.capabilities[capabilityIdOf('eslint')];
    expect(entry.refs).toEqual(['proj-A']);
    expect(entry.status).toBe('active');
    expect(entry.since).toBeUndefined();
  });

  it('active 能力再次 claim 不改变 status', () => {
    const claimed = claimToolRefs(refsWithSharedEslint(), 'C', ['eslint']);
    const entry = claimed.capabilities[capabilityIdOf('eslint')];
    expect(entry.status).toBe('active');
    expect(entry.since).toBeUndefined();
  });
});

describe('claimToolRefs languages（R3-b 云端元数据入账本）', () => {
  it('languagesByTool 提供时写入 CapabilityEntry.languages', () => {
    const base: CapabilityRefs = { schemaVersion: 1, capabilities: {} };
    const claimed = claimToolRefs(base, 'proj-A', ['eslint'], {
      eslint: ['typescript', 'javascript'],
    });
    const entry = claimed.capabilities[capabilityIdOf('eslint')];
    expect(entry.languages).toEqual(['typescript', 'javascript']);
  });

  it('缺省 languagesByTool → 新条目 languages 保持 []（R2 兼容）', () => {
    const base: CapabilityRefs = { schemaVersion: 1, capabilities: {} };
    const claimed = claimToolRefs(base, 'proj-A', ['eslint']);
    expect(claimed.capabilities[capabilityIdOf('eslint')].languages).toEqual([]);
  });

  it('已有 languages 被云端下发值覆盖', () => {
    const refs: CapabilityRefs = {
      schemaVersion: 1,
      capabilities: {
        [capabilityIdOf('eslint')]: { languages: ['old'], refs: ['A'], status: 'active' },
      },
    };
    const claimed = claimToolRefs(refs, 'B', ['eslint'], { eslint: ['typescript'] });
    expect(claimed.capabilities[capabilityIdOf('eslint')].languages).toEqual(['typescript']);
  });

  it('languagesByTool 未含该工具 → 保留原 languages', () => {
    const refs: CapabilityRefs = {
      schemaVersion: 1,
      capabilities: {
        [capabilityIdOf('eslint')]: { languages: ['old'], refs: ['A'], status: 'active' },
      },
    };
    const claimed = claimToolRefs(refs, 'B', ['eslint'], {});
    expect(claimed.capabilities[capabilityIdOf('eslint')].languages).toEqual(['old']);
  });
});

describe('R3c 领取投影（claim 前按 languagesByTool + 主语言过滤）', () => {
  const inScope = ['eslint', 'semgrep'];
  const languagesByTool = { eslint: ['typescript'], semgrep: ['*'] };

  function claimForLanguage(language: string | undefined): CapabilityRefs {
    const claimable = inScope.filter((toolId) =>
      isToolLanguagesMatch(languagesByTool[toolId], { language }),
    );
    return claimToolRefs({ schemaVersion: 1, capabilities: {} }, 'proj-go', claimable, languagesByTool);
  }

  it('go 项目：eslint 不进入 refs，semgrep（* 恒含）进入 refs', () => {
    const claimed = claimForLanguage('go');
    expect(claimed.capabilities[capabilityIdOf('eslint')]).toBeUndefined();
    expect(claimed.capabilities[capabilityIdOf('semgrep')].refs).toEqual(['proj-go']);
  });

  it('typescript 项目：eslint 与 semgrep 均进入 refs', () => {
    const claimed = claimForLanguage('typescript');
    expect(claimed.capabilities[capabilityIdOf('eslint')].refs).toEqual(['proj-go']);
    expect(claimed.capabilities[capabilityIdOf('semgrep')].refs).toEqual(['proj-go']);
  });

  it('languagesByTool 缺该工具（undefined）→ 保守不裁，仍进入 refs', () => {
    const claimable = ['eslint', 'semgrep'].filter(() =>
      isToolLanguagesMatch(undefined, { language: 'go' }),
    );
    const claimed = claimToolRefs(
      { schemaVersion: 1, capabilities: {} },
      'proj-x',
      claimable,
      {},
    );
    expect(claimed.capabilities[capabilityIdOf('eslint')].refs).toEqual(['proj-x']);
    expect(claimed.capabilities[capabilityIdOf('semgrep')].refs).toEqual(['proj-x']);
  });
});

describe('markReclaimed（R3-a 到期物理删除终态标记）', () => {
  it('reclaiming 条目 → reclaimed + at 为数值 + since 删除 + refs 保留', () => {
    const refs: CapabilityRefs = {
      schemaVersion: 1,
      capabilities: {
        [capabilityIdOf('eslint')]: {
          languages: [],
          refs: [],
          status: 'reclaiming',
          since: 1759747200000,
        },
      },
    };
    const marked = markReclaimed(refs, ['eslint']);
    const entry = marked.capabilities[capabilityIdOf('eslint')];
    expect(entry.status).toBe('reclaimed');
    expect(typeof entry.at).toBe('number');
    expect(entry.since).toBeUndefined();
    expect(entry.refs).toEqual([]);
  });

  it('active 条目不动（不标记、不加 at）', () => {
    const marked = markReclaimed(refsWithSharedEslint(), ['eslint']);
    const entry = marked.capabilities[capabilityIdOf('eslint')];
    expect(entry.status).toBe('active');
    expect(entry.at).toBeUndefined();
    expect(entry.since).toBeUndefined();
  });

  it('已 reclaimed 条目不动（at 保持原值）', () => {
    const refs: CapabilityRefs = {
      schemaVersion: 1,
      capabilities: {
        [capabilityIdOf('eslint')]: {
          languages: [],
          refs: [],
          status: 'reclaimed',
          at: 1759747200000,
        },
      },
    };
    const marked = markReclaimed(refs, ['eslint']);
    const entry = marked.capabilities[capabilityIdOf('eslint')];
    expect(entry.status).toBe('reclaimed');
    expect(entry.at).toBe(1759747200000);
  });

  it('未知 toolId 不产生新条目', () => {
    const base: CapabilityRefs = { schemaVersion: 1, capabilities: {} };
    const marked = markReclaimed(base, ['eslint']);
    expect(marked.capabilities).toEqual({});
  });

  it('混合账本：仅 reclaiming 条目被标记，active/reclaimed 不动', () => {
    const refs: CapabilityRefs = {
      schemaVersion: 1,
      capabilities: {
        [capabilityIdOf('eslint')]: {
          languages: [],
          refs: [],
          status: 'reclaiming',
          since: 1759747200000,
        },
        [capabilityIdOf('semgrep')]: { languages: [], refs: ['A'], status: 'active' },
        [capabilityIdOf('trivy')]: {
          languages: [],
          refs: [],
          status: 'reclaimed',
          at: 1759747200000,
        },
      },
    };
    const marked = markReclaimed(refs, ['eslint', 'semgrep', 'trivy']);
    expect(marked.capabilities[capabilityIdOf('eslint')].status).toBe('reclaimed');
    expect(marked.capabilities[capabilityIdOf('semgrep')].status).toBe('active');
    expect(marked.capabilities[capabilityIdOf('trivy')].status).toBe('reclaimed');
  });

  it('返回新对象，不原地改输入', () => {
    const refs: CapabilityRefs = {
      schemaVersion: 1,
      capabilities: {
        [capabilityIdOf('eslint')]: {
          languages: [],
          refs: [],
          status: 'reclaiming',
          since: 1759747200000,
        },
      },
    };
    const result = markReclaimed(refs, ['eslint']);
    expect(result).not.toBe(refs);
    const original = refs.capabilities[capabilityIdOf('eslint')];
    expect(original.status).toBe('reclaiming');
    expect(original.since).toBe(1759747200000);
    expect(original.at).toBeUndefined();
  });
});

describe('splitResolvedTools（R3-b 语言元数据入账本）', () => {
  it('拆分 toolIds + languagesByTool', () => {
    const split = splitResolvedTools([
      { toolId: 'eslint', languages: ['typescript', 'javascript'] },
      { toolId: 'semgrep', languages: [] },
    ]);
    expect(split.toolIds).toEqual(['eslint', 'semgrep']);
    expect(split.languagesByTool).toEqual({
      eslint: ['typescript', 'javascript'],
      semgrep: [],
    });
  });

  it('空输入 → 空结果', () => {
    const split = splitResolvedTools([]);
    expect(split.toolIds).toEqual([]);
    expect(split.languagesByTool).toEqual({});
  });

  it('languages 数组拷贝（不共享引用）', () => {
    const languages = ['typescript'];
    const split = splitResolvedTools([{ toolId: 'eslint', languages }]);
    languages.push('javascript');
    expect(split.languagesByTool.eslint).toEqual(['typescript']);
  });
});

describe('loadCapabilityRefs 降级（验收 1）', () => {
  it('缺文件 → 空账本（schemaVersion 1, capabilities {}）', async () => {
    const dir = makeTmpDir();
    const filePath = path.join(dir, 'capability-refs.json');
    const refs = await loadCapabilityRefs(filePath);
    expect(refs).toEqual({ schemaVersion: 1, capabilities: {} });
  });

  it('损坏 JSON → 空账本', async () => {
    const dir = makeTmpDir();
    const filePath = path.join(dir, 'capability-refs.json');
    fs.writeFileSync(filePath, '{ not valid json', 'utf-8');
    const refs = await loadCapabilityRefs(filePath);
    expect(refs).toEqual({ schemaVersion: 1, capabilities: {} });
  });

  it('结构异常（capabilities 非对象）→ 空账本', async () => {
    const dir = makeTmpDir();
    const filePath = path.join(dir, 'capability-refs.json');
    fs.writeFileSync(filePath, JSON.stringify({ schemaVersion: 1, capabilities: 'oops' }), 'utf-8');
    const refs = await loadCapabilityRefs(filePath);
    expect(refs).toEqual({ schemaVersion: 1, capabilities: {} });
  });
});

describe('saveCapabilityRefs + loadCapabilityRefs 往返（验收 1）', () => {
  it('save 后文件存在且可 parse，load 往返一致', async () => {
    const dir = makeTmpDir();
    const filePath = path.join(dir, 'capability-refs.json');
    const refs: CapabilityRefs = {
      schemaVersion: 1,
      capabilities: {
        [capabilityIdOf('eslint')]: { languages: [], refs: ['A'], status: 'active' },
      },
    };
    await saveCapabilityRefs(refs, filePath);
    expect(fs.existsSync(filePath)).toBe(true);
    const loaded = await loadCapabilityRefs(filePath);
    expect(loaded).toEqual(refs);
  });

  it('目录不存在时自动 mkdir recursive', async () => {
    const dir = makeTmpDir();
    const filePath = path.join(dir, 'nested', 'deep', 'capability-refs.json');
    await saveCapabilityRefs({ schemaVersion: 1, capabilities: {} }, filePath);
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('reclaimed + at 往返保留（R3-a 终态字段不被过滤）', async () => {
    const dir = makeTmpDir();
    const filePath = path.join(dir, 'capability-refs.json');
    const refs: CapabilityRefs = {
      schemaVersion: 1,
      capabilities: {
        [capabilityIdOf('eslint')]: {
          languages: [],
          refs: [],
          status: 'reclaimed',
          at: 1759747200000,
        },
      },
    };
    await saveCapabilityRefs(refs, filePath);
    const loaded = await loadCapabilityRefs(filePath);
    expect(loaded).toEqual(refs);
  });
});

describe('deriveProjectId（验收 1）', () => {
  it('同 path 幂等', () => {
    expect(deriveProjectId('/a/b/c')).toBe(deriveProjectId('/a/b/c'));
  });

  it('16 位 hex', () => {
    const id = deriveProjectId('/a/b/c');
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('不同 path 不同值', () => {
    expect(deriveProjectId('/a/b/c')).not.toBe(deriveProjectId('/a/b/d'));
  });
});

describe('capabilityIdOf / getReclaimingToolIds', () => {
  it('capabilityIdOf 构造 toolrule:<toolId>', () => {
    expect(capabilityIdOf('eslint')).toBe('toolrule:eslint');
  });

  it('getReclaimingToolIds 只收集 toolrule:* 且 reclaiming 的工具', () => {
    const refs: CapabilityRefs = {
      schemaVersion: 1,
      capabilities: {
        [capabilityIdOf('eslint')]: {
          languages: [],
          refs: [],
          status: 'reclaiming',
          since: 1759747200000,
        },
        [capabilityIdOf('semgrep')]: { languages: [], refs: ['A'], status: 'active' },
        'sop-module:typescript': {
          languages: ['typescript'],
          refs: [],
          status: 'reclaiming',
          since: 1759747200000,
        },
      },
    };
    expect(getReclaimingToolIds(refs)).toEqual(['eslint']);
  });
});

describe('defaultCapabilityRefsPath', () => {
  it('指向 ~/.zhshield/capability-refs.json', () => {
    expect(defaultCapabilityRefsPath()).toBe(
      path.join(os.homedir(), '.zhshield', 'capability-refs.json'),
    );
  });
});

// ─── SOP 模块账本纯函数（与 toolrule 对称） ──────────────────

describe('sopModuleIdOf', () => {
  it('构造 sop-module:<module>', () => {
    expect(sopModuleIdOf('typescript')).toBe('sop-module:typescript');
  });

  it('空字符串 → sop-module:', () => {
    expect(sopModuleIdOf('')).toBe('sop-module:');
  });
});

describe('claimSopModuleRefs 幂等', () => {
  it('同 projectId 两次 claim refs 不重复', () => {
    const base: CapabilityRefs = { schemaVersion: 1, capabilities: {} };
    const once = claimSopModuleRefs(base, 'proj-A', ['typescript']);
    const twice = claimSopModuleRefs(once, 'proj-A', ['typescript']);
    expect(twice.capabilities[sopModuleIdOf('typescript')].refs).toEqual(['proj-A']);
  });

  it('不同 projectId 各自入 refs', () => {
    const base: CapabilityRefs = { schemaVersion: 1, capabilities: {} };
    const a = claimSopModuleRefs(base, 'proj-A', ['typescript']);
    const ab = claimSopModuleRefs(a, 'proj-B', ['typescript']);
    expect(ab.capabilities[sopModuleIdOf('typescript')].refs).toEqual(['proj-A', 'proj-B']);
  });

  it('返回新对象，不原地改输入', () => {
    const base: CapabilityRefs = { schemaVersion: 1, capabilities: {} };
    const result = claimSopModuleRefs(base, 'proj-A', ['typescript']);
    expect(result).not.toBe(base);
    expect(base.capabilities).toEqual({});
  });

  it('新条目 languages 恒 []', () => {
    const base: CapabilityRefs = { schemaVersion: 1, capabilities: {} };
    const claimed = claimSopModuleRefs(base, 'proj-A', ['typescript']);
    expect(claimed.capabilities[sopModuleIdOf('typescript')].languages).toEqual([]);
  });

  it('已存在条目的 languages 保持不变', () => {
    const base: CapabilityRefs = {
      schemaVersion: 1,
      capabilities: {
        'sop-module:typescript': { languages: ['ts'], refs: ['X'], status: 'active' },
      },
    };
    const claimed = claimSopModuleRefs(base, 'proj-A', ['typescript']);
    expect(claimed.capabilities[sopModuleIdOf('typescript')].languages).toEqual(['ts']);
  });
});

describe('claimSopModuleRefs 唤醒', () => {
  it('reclaiming + since 条目被 claim 后 → active 且 delete since', () => {
    const reclaiming: CapabilityRefs = {
      schemaVersion: 1,
      capabilities: {
        'sop-module:typescript': {
          languages: [],
          refs: [],
          status: 'reclaiming',
          since: 1759747200000,
        },
      },
    };
    const claimed = claimSopModuleRefs(reclaiming, 'proj-A', ['typescript']);
    const entry = claimed.capabilities[sopModuleIdOf('typescript')];
    expect(entry.refs).toEqual(['proj-A']);
    expect(entry.status).toBe('active');
    expect(entry.since).toBeUndefined();
  });

  it('active 条目再次 claim 不改变 status', () => {
    const base: CapabilityRefs = {
      schemaVersion: 1,
      capabilities: {
        'sop-module:typescript': { languages: [], refs: ['X'], status: 'active' },
      },
    };
    const claimed = claimSopModuleRefs(base, 'proj-B', ['typescript']);
    const entry = claimed.capabilities[sopModuleIdOf('typescript')];
    expect(entry.status).toBe('active');
    expect(entry.since).toBeUndefined();
    expect(entry.refs).toEqual(['X', 'proj-B']);
  });
});

describe('markSopModulesReclaimed', () => {
  it('reclaiming 条目 → reclaimed + at 为数值 + since 删除 + refs 保留', () => {
    const refs: CapabilityRefs = {
      schemaVersion: 1,
      capabilities: {
        'sop-module:typescript': {
          languages: [],
          refs: [],
          status: 'reclaiming',
          since: 1759747200000,
        },
      },
    };
    const marked = markSopModulesReclaimed(refs, ['typescript']);
    const entry = marked.capabilities[sopModuleIdOf('typescript')];
    expect(entry.status).toBe('reclaimed');
    expect(typeof entry.at).toBe('number');
    expect(entry.since).toBeUndefined();
    expect(entry.refs).toEqual([]);
  });

  it('mark 只动 sop-module:* — toolrule 键不被误触', () => {
    const refs: CapabilityRefs = {
      schemaVersion: 1,
      capabilities: {
        [capabilityIdOf('eslint')]: {
          languages: [],
          refs: [],
          status: 'reclaiming',
          since: 1759747200000,
        },
        'sop-module:typescript': {
          languages: [],
          refs: [],
          status: 'reclaiming',
          since: 1759747200000,
        },
      },
    };
    const marked = markSopModulesReclaimed(refs, ['typescript']);
    expect(marked.capabilities[capabilityIdOf('eslint')].status).toBe('reclaiming');
    expect(marked.capabilities[capabilityIdOf('eslint')].since).toBe(1759747200000);
    expect(marked.capabilities[sopModuleIdOf('typescript')].status).toBe('reclaimed');
  });

  it('mark 不动 active 的 sop-module 条目', () => {
    const refs: CapabilityRefs = {
      schemaVersion: 1,
      capabilities: {
        'sop-module:typescript': { languages: [], refs: ['A'], status: 'active' },
      },
    };
    const marked = markSopModulesReclaimed(refs, ['typescript']);
    const entry = marked.capabilities[sopModuleIdOf('typescript')];
    expect(entry.status).toBe('active');
    expect(entry.at).toBeUndefined();
    expect(entry.since).toBeUndefined();
  });

  it('mark 不动不存在的 moduleId', () => {
    const base: CapabilityRefs = { schemaVersion: 1, capabilities: {} };
    const marked = markSopModulesReclaimed(base, ['nonexistent']);
    expect(marked.capabilities).toEqual({});
  });

  it('mark 不动已 reclaimed 的条目（at 保持原值）', () => {
    const refs: CapabilityRefs = {
      schemaVersion: 1,
      capabilities: {
        'sop-module:typescript': {
          languages: [],
          refs: [],
          status: 'reclaimed',
          at: 1759747200000,
        },
      },
    };
    const marked = markSopModulesReclaimed(refs, ['typescript']);
    const entry = marked.capabilities[sopModuleIdOf('typescript')];
    expect(entry.status).toBe('reclaimed');
    expect(entry.at).toBe(1759747200000);
  });

  it('混合账本：仅 reclaiming sop-module 被标记，toolrule/active/reclaimed 不动', () => {
    const refs: CapabilityRefs = {
      schemaVersion: 1,
      capabilities: {
        [capabilityIdOf('eslint')]: {
          languages: [],
          refs: [],
          status: 'reclaiming',
          since: 1759747200000,
        },
        'sop-module:typescript': {
          languages: [],
          refs: [],
          status: 'reclaiming',
          since: 1759747200000,
        },
        'sop-module:go': { languages: [], refs: ['A'], status: 'active' },
        'sop-module:python': {
          languages: [],
          refs: [],
          status: 'reclaimed',
          at: 1759747200000,
        },
      },
    };
    const marked = markSopModulesReclaimed(refs, ['typescript', 'go', 'python']);
    expect(marked.capabilities[capabilityIdOf('eslint')].status).toBe('reclaiming');
    expect(marked.capabilities[sopModuleIdOf('typescript')].status).toBe('reclaimed');
    expect(typeof marked.capabilities[sopModuleIdOf('typescript')].at).toBe('number');
    expect(marked.capabilities[sopModuleIdOf('go')].status).toBe('active');
    expect(marked.capabilities[sopModuleIdOf('python')].at).toBe(1759747200000);
  });

  it('返回新对象，不原地改输入', () => {
    const refs: CapabilityRefs = {
      schemaVersion: 1,
      capabilities: {
        'sop-module:typescript': {
          languages: [],
          refs: [],
          status: 'reclaiming',
          since: 1759747200000,
        },
      },
    };
    const result = markSopModulesReclaimed(refs, ['typescript']);
    expect(result).not.toBe(refs);
    const original = refs.capabilities[sopModuleIdOf('typescript')];
    expect(original.status).toBe('reclaiming');
    expect(original.since).toBe(1759747200000);
    expect(original.at).toBeUndefined();
  });
});
