import { contextBridge, ipcRenderer } from 'electron';
import type { ExperienceRecord } from '@zh/kernel';
import type { ExperienceEntry } from '@zh/evolve';

contextBridge.exposeInMainWorld('electronAPI', {
  // 应用信息
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  getToolAvailability: () => ipcRenderer.invoke('tools:availability'),

  // 国际化
  getLocale: () => ipcRenderer.invoke('app:getLocale'),
  setLanguage: (lng: string) => ipcRenderer.send('i18n:set-language', lng),

  // 窗口控制
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:isMaximized'),

  // 窗口状态监听
  onMaximized: (callback: (maximized: boolean) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, maximized: boolean) => callback(maximized);
    ipcRenderer.on('window:maximized', handler);
    return () => ipcRenderer.removeListener('window:maximized', handler);
  },

  // 流水线进度监听
  onPipelineProgress: (callback: (progress: { stage: string; message: string; progress: number }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { stage: string; message: string; progress: number }) => callback(data);
    ipcRenderer.on('engine:pipeline:progress', handler);
    return () => ipcRenderer.removeListener('engine:pipeline:progress', handler);
  },

  // 平台信息
  platform: process.platform,

  // 项目持久化
  loadProjects: () => ipcRenderer.invoke('app:loadProjects'),
  saveProjects: (projects: Array<{ name: string; path: string }>) => ipcRenderer.invoke('app:saveProjects', projects),

  // 对话框
  openFolderDialog: () => ipcRenderer.invoke('dialog:openFolder'),
  showSaveDialog: (options: { defaultPath: string; filters: Array<{ name: string; extensions: string[] }> }) =>
    ipcRenderer.invoke('dialog:showSave', options),
  writeFile: (filePath: string, content: string) =>
    ipcRenderer.invoke('dialog:writeFile', filePath, content),

  /** 打开外部链接或已注册 URL scheme（如 trae://）,返回是否成功唤起 */
  openExternal: (url: string) => ipcRenderer.invoke('app:openExternal', url),

  // ─── AI 编程工具集成 ────────────────────────────────────
  ai: {
    loadConfig: () => ipcRenderer.invoke('ai:loadConfig'),
    saveConfig: (config: { id: string; name: string; enabled: boolean; mode: 'linter' | 'cli'; configFile: string }, projectPaths: string[]) =>
      ipcRenderer.invoke('ai:saveConfig', config, projectPaths),
  },
  
  // ─── SOP 规则同步（智汇云脑） ────────────────────────────
  sop: {
    getVersion: () => ipcRenderer.invoke('sop:getVersion'),
    syncNow: () => ipcRenderer.invoke('sop:syncNow'),
    getStats: () => ipcRenderer.invoke('sop:getStats'),
    getSyncHealth: () => ipcRenderer.invoke('sop:getSyncHealth'),
    emergencyUpdate: (rulesJson: string) => ipcRenderer.invoke('sop:emergencyUpdate', rulesJson),
    checkRules: (domain?: string) => ipcRenderer.invoke('sop:checkRules', domain),
  },

  // ─── 云脑协同：工具规则下发 + 经验回写 ──────────────────
  sync: {
    syncRules: () => ipcRenderer.invoke('sync:rules'),
    getRulesStatus: () => ipcRenderer.invoke('sync:rulesStatus'),
    emergencyUpdate: (toolId: string) => ipcRenderer.invoke('sync:emergencyUpdate', toolId),
    submitExperience: (records: ExperienceRecord[]) => ipcRenderer.invoke('sync:submitExperience', records),
    getQueueStatus: () => ipcRenderer.invoke('sync:queueStatus'),
  },

  // ─── 治理引擎（Guard / Inspect / Security / Scoring）────
  engine: {
    runGuard: (projectPath: string, options?: Record<string, unknown>) =>
      ipcRenderer.invoke('engine:runGuard', projectPath, options),
    runInspect: (projectPath: string) =>
      ipcRenderer.invoke('engine:runInspect', projectPath),
    runSecurity: (projectPath: string) =>
      ipcRenderer.invoke('engine:runSecurity', projectPath),
    cleanGarbage: (projectPath: string, items: Array<{ id: string; path: string; size: number; type: string }>) =>
      ipcRenderer.invoke('engine:garbageClean', projectPath, items),
    restoreGarbage: (projectPath: string, batchId: string) =>
      ipcRenderer.invoke('engine:garbageRestore', projectPath, batchId),
    runPerformance: (projectPath: string) =>
      ipcRenderer.invoke('engine:runPerformance', projectPath),
    getScore: (projectId: string) =>
      ipcRenderer.invoke('engine:getScore', projectId),
    getScoreHistory: (projectId: string) =>
      ipcRenderer.invoke('engine:getScoreHistory', projectId),
    runRefactor: (projectPath: string) =>
      ipcRenderer.invoke('engine:runRefactor', projectPath),
    runDeps: (projectPath: string) =>
      ipcRenderer.invoke('engine:runDeps', projectPath),
    runTechDebt: (projectPath: string) =>
      ipcRenderer.invoke('engine:runTechDebt', projectPath),
    planDebtRepayment: (projectPath: string, actionId: string, opts?: { sprint?: string; gate?: 'allow-with-record' }) =>
      ipcRenderer.invoke('debt:planRepayment', projectPath, actionId, opts),
    verifyDebtRepaid: (projectPath: string, actionId: string) =>
      ipcRenderer.invoke('debt:verifyRepaid', projectPath, actionId),
    dismissDebtAction: (projectPath: string, actionId: string) =>
      ipcRenderer.invoke('debt:dismiss', projectPath, actionId),
    runSecrets: (projectPath: string) =>
      ipcRenderer.invoke('engine:runSecrets', projectPath),
    markSecretRotating: (secretId: string) =>
      ipcRenderer.invoke('engine:secretRotating', secretId),
    verifySecretRotated: (secretId: string) =>
      ipcRenderer.invoke('engine:secretVerify', secretId),
    dismissSecret: (secretId: string, reason: string) =>
      ipcRenderer.invoke('engine:secretDismiss', secretId, reason),
    runPipeline: (projectPath: string, options?: { dryRun?: boolean; sop?: boolean; presetName?: string }) =>
      ipcRenderer.invoke('engine:runPipeline', projectPath, options),
    runProfile: (projectPath: string) =>
      ipcRenderer.invoke('engine:runProfile', projectPath),
  },

  // ─── 统一任务调度（受限并发 + 排队，状态/进度实时广播）────
  tasks: {
    start: (kind: string, projectPath: string, options?: Record<string, unknown>) =>
      ipcRenderer.invoke('tasks:start', kind, projectPath, options),
    list: () => ipcRenderer.invoke('tasks:list'),
    cancel: (id: string) => ipcRenderer.invoke('tasks:cancel', id),
    onChanged: (callback: (task: { id: string; kind: string; projectPath: string; status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'; stage?: string; message?: string; progress: number; startedAt: string; finishedAt?: string; result?: unknown; error?: string; queuePosition?: number }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, task: Parameters<typeof callback>[0]) => callback(task);
      ipcRenderer.on('tasks:changed', handler);
      return () => ipcRenderer.removeListener('tasks:changed', handler);
    },
  },

  // ─── 误报反馈（门禁 / 哨兵标记误报，落盘供智汇大脑校准）───
  feedback: {
    reportFalsePositive: (projectPath: string, item: { source: 'guard' | 'sentinel'; ruleId: string; title?: string; message: string; severity?: string; file?: string; line?: number }) =>
      ipcRenderer.invoke('feedback:reportFalsePositive', projectPath, item),
    listFalsePositives: (projectPath: string, source?: 'guard' | 'sentinel') =>
      ipcRenderer.invoke('feedback:listFalsePositives', projectPath, source),
  },

  // ─── 门禁 git hooks（本地自动守护）──────────────────────
  guardHooks: {
    getStatus: (projectPath: string) =>
      ipcRenderer.invoke('guard:hooksStatus', projectPath),
    install: (projectPath: string) =>
      ipcRenderer.invoke('guard:installHooks', projectPath),
    uninstall: (projectPath: string) =>
      ipcRenderer.invoke('guard:uninstallHooks', projectPath),
    listReports: (projectPath: string, limit?: number) =>
      ipcRenderer.invoke('guard:listReports', projectPath, limit),
  },

  // ─── 门禁配置持久化 ──────────────────────────────────────
  guardConfig: {
    read: () => ipcRenderer.invoke('guard:readConfig'),
    write: (config: { preCommit: boolean; prePush: boolean; blockOnCritical: boolean }) =>
      ipcRenderer.invoke('guard:writeConfig', config),
  },

  // ─── 哨兵监控 ──────────────────────────────────────────────
  sentinel: {
    getEvents: (options?: { status?: string; severity?: string }) =>
      ipcRenderer.invoke('sentinel:getEvents', options),
    getEvent: (id: string) =>
      ipcRenderer.invoke('sentinel:getEvent', id),
    startMonitoring: (projectId: string, projectPath: string) =>
      ipcRenderer.invoke('sentinel:startMonitoring', projectId, projectPath),
  },

  // ─── 一键备份 ──────────────────────────────────────────────
  backup: {
    executeBackup: (projectPath: string, trigger?: string) =>
      ipcRenderer.invoke('backup:execute', projectPath, trigger),
    getRecords: (projectId?: string) =>
      ipcRenderer.invoke('backup:records', projectId),
    getRecord: (recordId: string) =>
      ipcRenderer.invoke('backup:record', recordId),
    deleteRecord: (recordId: string) =>
      ipcRenderer.invoke('backup:deleteRecord', recordId),
    getConfig: (projectPath: string) =>
      ipcRenderer.invoke('backup:getConfig', projectPath),
    saveConfig: (projectPath: string, config: unknown) =>
      ipcRenderer.invoke('backup:saveConfig', projectPath, config),
    authorizeGitHub: () =>
      ipcRenderer.invoke('backup:authorizeGitHub'),
    openFolder: (folderPath: string) =>
      ipcRenderer.invoke('backup:openFolder', folderPath),
  },

  // ─── 演进引擎 ──────────────────────────────────────────────
  evolve: {
    getSuggestions: (projectId: string) =>
      ipcRenderer.invoke('evolve:getSuggestions', projectId),
    listExperiences: (projectId: string) =>
      ipcRenderer.invoke('evolve:listExperiences', projectId),
    getRuleWeights: () =>
      ipcRenderer.invoke('evolve:getRuleWeights'),
    recordExperience: (entry: Omit<ExperienceEntry, 'id' | 'createdAt' | 'updatedAt'>) =>
      ipcRenderer.invoke('evolve:recordExperience', entry),
    autoAdjustWeights: () =>
      ipcRenderer.invoke('evolve:autoAdjustWeights'),
  },

  // ─── 应用更新 ──────────────────────────────────────────────
  update: {
    check: () => ipcRenderer.invoke('update:check'),
    download: () => ipcRenderer.invoke('update:download'),
    install: () => ipcRenderer.invoke('update:install'),
    onStatus: (callback: (status: { state: string; version?: string; percent?: number; message?: string }) => void) => {
      ipcRenderer.on('update:status', (_event, status) => callback(status));
    },
  },

  // ─── 调度器状态持久化 ──────────────────────────────────────
  scheduler: {
    readState: () =>
      ipcRenderer.invoke('scheduler:readState'),
    writeState: (state: { jobs: unknown[] }) =>
      ipcRenderer.invoke('scheduler:writeState', state),
  },
});
