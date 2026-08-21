import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
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
  'packages/shared',
]);
