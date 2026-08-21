# 智汇码盾 i18n 迁移指南

本文件是 i18n 迁移的唯一权威契约。所有迁移 agent 必须严格遵守。

## 1. API 契约

### React 组件（desktop renderer）

```tsx
import { useT } from '../i18n'; // 相对路径按文件位置调整（pages/ 下是 ../i18n，components/ 下是 ../../i18n）

function MyComponent() {
  const t = useT(); // 语言切换时自动重渲染
  return <button>{t('common.confirm')}</button>;
}
```

- **任何渲染了翻译文本的组件都必须自己调用 `useT()`**，不能依赖父组件透传。
- 插值：`t('page.guard.foundCount', { count: 12 })`，目录中用 `{{count}}`。
- 需要切换语言的组件（语言设置区）：`const { language, setLanguage } = useI18n();`

### 非组件代码（*-logic.ts / services / utils / electron 主进程 / CLI / 引擎）

```ts
import { t } from '@zh/i18n';                       // 全局当前语言
import { translate } from '@zh/i18n';               // 显式语言，无状态
translate('engine.security.vulnUpgrade', locale, { version: '1.2.3' });
```

### 标签字典模式（关键！）

`*-logic.ts` 里的标签字典（`SEVERITY_CONFIG` / `STATUS_CONFIG` / `TYPE_LABELS` 等）：
把 `text: '严重'` 改为 `textKey: 'severity.critical'`，**保留 color/bg 等样式字段**。
渲染处用 `t(SEVERITY_CONFIG[s].textKey)`。字典本身保持模块级常量（不引入 hooks）。

## 2. 键命名约定（顶级命名空间）

| 命名空间 | 用途 | 示例 |
|---|---|---|
| `common.*` | 通用按钮/操作 | `common.confirm` |
| `severity.*` | 严重度 | `severity.critical` |
| `status.*` | 状态 | `status.detected` |
| `lifecycle.*` | 生命周期 | `lifecycle.detect` |
| `nav.*` | 顶部导航 | `nav.dashboard` |
| `layout.*` | 侧栏/顶栏/品牌 | `layout.theme`, `layout.language` |
| `page.<id>.*` | 各功能页（id: dashboard/guard/sentinel/inspect/security/garbage/performance/refactor/backup/reports/evolve/welcome） | `page.guard.scan` |
| `toast.*` | Toast/提示 | `toast.projectAdded` |
| `electron.*` | Electron 主进程（菜单/对话框/任务） | `electron.taskStatus.done` |
| `cli.*` | CLI 输出 | `cli.usage` |
| `reporter.*` | 控制台报告 | `reporter.header` |
| `engine.*` | 引擎数据字段（Issue.message/recommendation/insights 等） | `engine.security.vulnUpgrade` |
| `sop.*` | SOP 规则名/描述 | `sop.rule.sensitiveInfo` |

**子键风格**：点号小驼峰。如 `page.guard.statusBanner.pass`、`engine.refactor.smell.R01`。

## 3. 已种子化键（必须复用，禁止重复定义）

已存在于 `packages/i18n/locales/zh-Hans.json`：
- `common.*`: confirm/cancel/save/delete/remove/close/copy/copyToAi/copied/loading/yes/no/retry/search/refresh
- `severity.*`: critical/high/medium/low/info
- `status.*`: detected/assigned/fixing/pr_opened/validating/passed/failed/merged/deployed/rolled_back/manual_taken_over
- `lifecycle.*`: detect/fix/validate/archive
- `nav.*`: dashboard/guard/sentinel/inspect/security/garbage/performance/refactor/backup/reports/evolve

遇到与种子键语义相同的字符串，**直接用种子键**，不要新建。

## 4. 片段（fragment）工作流

**不要直接编辑** `packages/i18n/locales/*.json`（除自己的片段文件）。

每个 agent 把自己提取的新键写入独立的片段文件：
`packages/i18n/locales/fragments/<分配的文件名>.json`

片段格式（与 zh-Hans.json 同构的嵌套 JSON，值 = 简体中文原文）：

```json
{
  "page": {
    "guard": {
      "scan": "立即扫描",
      "foundCount": "发现 {{count}} 个问题"
    }
  }
}
```

规则：
- 片段只含**简体中文值**（翻译由后续 agent 处理，不是你的工作）。
- 叶子键值必须是字符串；支持 i18next 插值 `{{param}}`。
- 英文复数场景：目录键用 `key_one` / `key_other`（i18next 约定），值用 `{{count}}`。中文键不加后缀（中文无复数）。

## 5. 硬性规则

**MUST DO**
- 只替换**用户可见字符串**（JSX 文本、按钮、标题、Toast、aria-label、placeholder、字典 label、错误消息、控制台输出）。
- 中文注释/JSDoc **保留不动**（面向开发者，不国际化）。
- 迁移后运行类型检查（desktop: `npx tsc --noEmit`），确保零错误。
- 保留原始语义、样式、颜色、布局不变——只换字符串来源。
- 插值变量名要语义化（`{{projectName}}` 而非 `{{name}}`）。
- 模板字符串拼接（`项目「${name}」已添加`）→ `t('toast.projectAdded', { name })`，目录值 `项目「{{name}}」已添加`。

**MUST NOT DO**
- 禁止改动你任务范围之外的任何文件（含测试文件、其他 agent 的文件）。
- 禁止编辑 `packages/i18n/locales/*.json`（除自己的片段文件）。
- 禁止引入新依赖。
- 禁止改行为逻辑、颜色、数值、数据结构。
- 禁止删/改中文注释。
- 禁止修改 `.zhshield`、配置、e2e 测试（收尾阶段统一处理）。
- 禁止在代码中新建与种子键语义重复的键。
- 不要用 `Trans` 组件，除非插值包含 JSX 元素且无法避免。
