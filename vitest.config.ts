import { defineConfig } from 'vitest/config';

// Vitest 4 迁移：`vitest.workspace.ts`（defineWorkspace API）已被移除，
// 改用根配置中的 `test.projects` 声明各包项目（各包自带 vitest.config.ts）。
export default defineConfig({
  test: {
    projects: [
      'packages/db',
      'packages/kernel',
      'packages/scoring',
      'packages/reporter',
      'packages/pipeline',
      'packages/refactor',
      'packages/cli',
      'packages/guard',
      'packages/inspect',
      'packages/security',
      'packages/sentinel',
      'packages/evolve',
      'packages/server',
      'packages/desktop',
      'packages/dependency',
      'packages/shared',
    ],
  },
});
