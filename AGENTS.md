# zhihui-codeshield 代码仓库规则

pnpm + Turborepo monorepo，21 个 `@zh/*` 包。依赖方向：客户端 → 引擎 → `kernel` / `shared` / `db`；引擎之间不互相 import，横向通信走 EventBus。

## ⛔ Git 安全红线（最高优先级）

2026-08-20 曾有 AI 子代理在本仓库执行 `git stash` + `git stash pop`，而当时仓库只有 1 个初始提交（8月3日），导致 256 个源文件被整体打回旧版、后续多轮工作丢失。为杜绝重演，以下命令**一律禁止**：

- `git stash` / `git stash pop` / `git stash drop`
- `git reset --hard`
- `git checkout -- .` / `git checkout <ref> -- .`
- `git restore .` / `git restore --source=...`
- `git clean -fd`

**如果发现工作区状态异常（文件丢失/内容回退）：立即停止操作，向用户报告现状与证据。不要试图用破坏性命令"修复"。**

### 硬拦截已生效（2026-08-22）

上述命令已在三层 opencode 配置中通过 `permission.bash` 规则 **硬性 deny**（全局 `~/.config/opencode/opencode.jsonc` + 外层 `opencode.json` + 本仓库 `opencode.json`），AI 执行会直接被拒绝。不要尝试绕过。

### 安全替代方案（必须用这些，不要用 stash）

| 需求 | 禁止 ❌ | 正确做法 ✅ |
|------|--------|-----------|
| 在干净代码树上跑测试/类型检查 | `git stash && test && git stash pop` | `git worktree add /tmp/wt-check HEAD` 后在 worktree 里跑 |
| 放弃某文件本地改动 | `git checkout -- <file>` / `git restore <file>` | 先 `git diff <file>` 备份内容到临时文件，问用户后再处理 |
| 撤销提交 | `git reset --hard` | `git revert`（生成反向提交） |

## 提交纪律

- 小步原子提交，语义化前缀（`feat:` / `fix:` / `chore:` / `refactor:`）
- **提交后必须推送**：commit ≠ 备份，push 才是。2026-10-24 发现 365 个提交里 87 个从未推送、远端只有 277 个，本地磁盘是唯一副本。推送后核对 `git rev-list --left-right --count origin/main...HEAD` 应为 `0	0`
- **未推送提示钩子**：`scripts/git-hooks/post-commit` 会在每次提交后打印未推送数量。`.git/hooks/` 不入库，换机器后需重装：`cp scripts/git-hooks/post-commit .git/hooks/ && chmod +x .git/hooks/post-commit`
- **push protection 会拦测试夹具里的假密钥**：`packages/inspect/e2e/fixtures/zh-inspect-fixture/src/secret2.ts:4` 的假 `ghp_` 与 Stripe 官方测试键，会让任何含其变更的分支被拒。报错措辞是 `push declined due to repository rule violations`，**不是** rulesets（查 rulesets 是空的）而是 secret scanning；且 `--dry-run` 不触发服务端扫描，**别用它验证可推性**。要彻底解决需把该夹具改成 gitleaks allowlist 形态
- 本地备份（`.zhshield/backups/` 与 `~/zhshield-backups/`）现已包含 `.git/`，恢复时会带回完整提交历史
- zhcheck pre-commit 门禁已两次真实拦截提交（large-class 300 行阈值）。被拦时**禁止 `--no-verify`**：优先把不依赖实例状态的纯函数提为模块级函数给类体瘦身（runner.ts / pipeline-runner.ts 均有先例）

## ⚠️ 本机资源纪律（8GB Intel Mac，必读）

- **测试与 typecheck 严禁并行跑**：两者同时执行必然 OOM（进程被 SIGKILL / exit 137），产生假失败。串行执行；`pnpm test` 脚本已内置 `--concurrency=1`，勿改
- **全量 typecheck 约 13 分钟**：只改了单包时用 `pnpm --filter @zh/<pkg> exec tsc --noEmit` 验证该包即可，不要每次跑全量
- **desktop E2E 本机不可跑**：宿主 AI 工具环境会泄漏 `ELECTRON_RUN_AS_NODE`（Electron 退化为 Node 模式、参数全拒）与 `NODE_OPTIONS`（safe-delete shim 拦截 Playwright 清理 test-results）；macOS Saved Application State 写入亦会被拦截。spec 已做三重防御（剥离环境变量 + HOME 重定向），首跑验证依赖 CI 的 `desktop-e2e` job
- **并行开发注意**：多 AI 工具同时改代码是常态，验证前先 `git status` 确认文件当前状态，撞上中间态编译失败先重跑一次再下结论

## 常用命令

| 命令 | 说明 |
|------|------|
| `pnpm build` | Turborepo 构建全部包 |
| `pnpm test` | 全部 Vitest |
| `pnpm lint` | ESLint（各包 src） |
| `pnpm --filter @zh/<pkg> exec tsc --noEmit -p tsconfig.json` | 单包类型检查 |
| `pnpm bench:pipeline` | **A14** 全量流水线时长验收：N 次取中位数、负载门限、产物新鲜度；PASS/FAIL/INVALID 三态 |
| `pnpm verify:offline` | **A15** 断网端到端：不可达 → `partial` + exit 2；同时用本地桩验证"可达时验得出来" |
| `pnpm verify:tool-dedup` | **A12** 工具进程去重：从 `child_process` 派发侧观测真实 (cmd, args) 计数 |
| `pnpm verify:dist-fresh` | **§5.3** 产物新鲜度：提交的 `dist/zhshield.js` 必须由当前源码构建（比对 bundle 头部的源码指纹） |

三条验收脚本的设计纪律（改它们之前先读）：**没效力的测量判 `INVALID`，不判 PASS/FAIL**；**数字必须带出处**（commit / dist 哈希 / 负载写进 `.zhshield/bench/*.json`）；**观测在进程外**，不采信被测代码自报的计数。详见《07》§7.7。

## ⚠️ 提交产物纪律：`dist/zhshield.js` 必须与源码同步（2026-11-04）

`packages/cli/dist/zhshield.js` 是**提交进 git** 的产物（GitHub Action 与 npx 直装依赖它）。
只要改了任何会被打包的 `packages/*/src`，就必须 `pnpm --filter zhshield-cli build` 并
把重建后的 bundle 一起提交 —— 否则 `pnpm test`/`typecheck`（跑 src）永远绿，而用户跑的是旧代码。

- 门禁：`pnpm verify:dist-fresh`（CI 在 Build 之后跑 `--no-build`）。判据是 bundle 头部的
  `// @zh-src-hash:` 指纹（esbuild 实际打包文件的内容哈希），**不是**文件字节比对 ——
  ubuntu CI 比 macOS 产物会因平台差异误报，指纹只看源码内容，跨平台稳定。
- 报错 `❌ 已提交的 CLI bundle 与当前源码不一致（产物过期）` 时：`build` 完把
  `packages/cli/dist/zhshield.js` 一起 `git add` 即可。
- ⚠️ `pnpm verify:dist-fresh` **默认会先重建 bundle**（`build-cli.mjs`），这会覆盖工作区
  里的 `dist/zhshield.js`。工作区有其他未提交工作时，用它做校验等于把别人的改动打进产物。
  只做校验要加 `--no-build`。

### 在干净 worktree 里构建 bundle（多会话并行时）

工作区里有他人未提交的 `packages/*/src` 改动时，**不要**直接 `pnpm --filter zhshield-cli build` ——
esbuild 会把整棵工作区源码打进产物，等于替别人做了「这些小改可以发布」的决定。正确做法是在
`git worktree add /tmp/wt-bundle HEAD` 里构建（同「安全替代方案」表），再只把
`packages/cli/dist/zhshield.js` 拷回工作区。

**硬约束：worktree 里的 `node_modules` 必须真实安装，绝不可软链回原仓库。**

```bash
cd /tmp/wt-bundle && pnpm install --frozen-lockfile --prefer-offline   # 约 2.5 分钟
```

2026-11-14 实测：先用 `ln -s <原仓库>/node_modules`（以及 21 个子包的）复用依赖，esbuild 按
**realpath** 解析，把 `../../../../../Users/<用户>/...` 绝对路径嵌进 bundle —— 产出 5000+ 行
无意义 diff，并把本机 home 路径泄露进将发布给所有用户的 CLI。改为真实安装后，与 HEAD 的 diff
收敛到 33 行（1 行指纹 + 实际代码改动）。

判据（提交前自查，两条都要过）：

1. `git diff --stat` 的改动行数与实际源码改动相称；凭空多出几千行就是路径污染。
2. `grep -c "Users/" packages/cli/dist/zhshield.js` 为 0，且 `grep -c "/tmp/wt-"` 为 0。
   （产物里本就有 `"/private/tmp/"` 这个源码常量，属正常，别误判。）

## ⚠️ Monorepo 依赖陷阱：pnpm 注入副本不同步（已踩三次，必读）

**现象**：新增或删除某个包的 `.ts` 源文件后，下游包测试突然报 `Cannot find module './xxx'`，且**单跑也不过**，看起来像代码缺陷。

**根因**：pnpm 对 `file:` 目录依赖（本仓库的 `@zh/*` 全部如此）生成的是**实体副本**（`node_modules/.pnpm/@zh+xxx@file+packages+xxx/node_modules/@zh/xxx`），不是符号链接。已存在的文件会随源码更新，但**新增的文件永远不会自动出现**在副本里。

**已验证无效的修复手段**（不要浪费时间重试）：

- `pnpm install` → `Already up to date`（lockfile 未变就跳过）
- `pnpm install --force` → 同样跳过，1.3s 结束
- 删除 `node_modules/.modules.yaml` 后重装 → 仍跳过

**唯一有效修复**：删除**消费者**的 node_modules 后重装，触发副本重新导入：

```bash
rm -rf packages/<消费者包>/node_modules && pnpm install --prefer-offline   # 约 47s
```

**纪律**：任何「新建 / 删除 / 重命名 `.ts` 源文件」的重构，提交前必须重建受影响消费者的 node_modules 并跑通其测试。

**自检**：`node scripts/check-injected-copies.mjs`（比对消费者实际解析到的注入副本与源 `src`/`dist` 两棵树，`__tests__` 与 `.DS_Store` 除外，不同步则 exit 1）。只比 dist 会漏掉「新增 `.ts` 源文件」导致的 TS2307（2026-11-02 实锤），故两棵树都必须比。`bash scripts/verify-env.sh` 的第 3.5 步已内置该检查。

**源 dist 过期提醒**（2026-11-04 新增）：脚本还会对「源 `dist` 比源 `src` 旧」的包打印 ⚠️ 提醒（不阻断、不 exit 1 —— 改完 src 未 build 是常态，不该因此拦住无关提交）。这条提醒来自一次真实事故：改了 `shared` 的 src、`dist` 只有部分被重建，`desktop` 的 `vitest.config.ts` require 到 `@zh/shared` 的 dist 时抛 `Cannot find module './tool-exec-primitives'` —— 报错完全不指向真因（缺的是"没 build"）。**下游跑测试/构建报 `Cannot find module './<新文件>'` 时，先看这条提醒，再去查代码。**

**历史事故**：08-30 security dist 过期导致 desktop typecheck 红灯；09-03 kernel `content-predicates` 与 pipeline `runner-utils` 导致 desktop 两个测试文件加载失败。

## ⚠️ 测试隔离与观测保真四条陷阱（2026-11-03 实锤）

1. **探测缓存是进程级状态**：`@zh/shared/tool-probe.ts` 把 `--version` 探测在进程内合并（A12 切片）。测试环境默认**关闭**缓存（`VITEST === 'true'`），否则同一 worker 里跑多个测试文件时，上一个文件 mock 出来的"工具不可用"会漏进下一个文件——实测表现为 `rule-quality-gate` 的 `path-traversal` 真阳性"0 检出"，红得和规则退化一模一样。要测缓存本身，用 `__resetToolProbeCache()` 显式开启。
2. **不要往 `os.tmpdir()` 根写夹具**：`hallucinated-dependency` 会向上查找最近的依赖清单，临时目录根若残留一个 `package.json`，「无任何依赖清单」类用例就恒红且看起来像产品缺陷（实测踩过）。夹具一律 `mkdtemp` 到子目录；该用例已加祖先清单自检，命中时直接打印要删的文件。
3. **改观测器先验观测器**：`scripts/lib/tool-spy.cjs` 包装 `child_process` 时必须复刻 `util.promisify.custom`。缺这一步，产品侧 `promisify(execFile)` 退回回调单值形态、`stdout` 变 undefined，于是**所有工具都被判成不可用**（实测让 `inspect --sop` 报 18 项"工具不可用"、semgrep 一次未派发，几乎被当成产品结论）。观测器失真比不观测更危险。
4. **mock `node:child_process` 只罩得住「被 Vite 改写的模块」**：用例里 `vi.mock('node:child_process')` 对 `@zh/shared` **内部**的派发有效的前提，是该包的 `vitest.config.ts` 把 `@zh/shared` 别名到 `../shared/src`。不别名时 `@zh/shared` 从 node_modules(dist) 加载、被外部化，mock 完全失效——实测 2026-11-03 工具调用改走 `runToolOnce` 后，`guard` 1 条、`security` 19 条用例假红（期望"没调外部工具"或"按 args 调了"，实际根本没进 mock）。**新增对 `@zh/shared` 派发做断言的用例前，先确认本包 vitest 配置有该别名**（guard/security 已补，注释见两处 config）。

## 工具调用约定（A12 执行面）

外部工具**必须**经 `@zh/shared` 的两个入口派发，不要直接 `execFile`/`spawn`：

- **可用性探测**：`probeToolVersion(command)` —— 进程级 single-flight + 30s TTL，缓存 key 是**可执行文件 realpath**（裸名与绝对路径归一，不同安装不合并），只缓存结论明确的结果（超时/信号不缓存）。
- **实际执行**：`runToolOnce(command, args, {cwd, timeout, maxBuffer})` —— 运行作用域内同一 `(command, argv, cwd)` 只执行一次，其余重放（成功重放输出；非零退出重放带 stdout 的错误快照；超时/信号/ENOBUFS 重试）。作用域由 `withToolRunScope(label, fn)` 开启，已挂在 `runDomains`、`kernel.runInspect`、`kernel.runGuard`。
- **可合并的工具**：`ToolAdapter.scanBatch?(requests)` + `kernel/runner/prefetch-tool-batch.ts` —— 同工具、同目标、带内联 rules 的规则合并成**一次**进程（semgrep 已实现：`semgrep scan` 10 → 2，SOP security 域 ≈90s → ≈20s）。新增可合并工具时：在 `BATCHABLE_TOOLS` 登记 + 适配器实现 `scanBatch`（**归属正确性是硬要求**：每个 key 只能拿到自己规则的命中；无法归属必须**失败关闭**，不能落成"干净"）。逃生开关 `ZH_TOOL_BATCH=off`。
  - ⚠️ 两个必踩的坑：`wrapAdapter` 用展开运算符包装，**原型方法不会被拷贝** → 新能力要在包装器里显式转发（`scanBatch` 已加）；semgrep 会把 `--config` 文件路径当命名空间编进 `check_id`（`<路径>.zhb0--a1`），回填必须按**末段**匹配而非全等。

**已覆盖**：inspect 全部适配器（经 `execTool`）、security 的 secrets/`vulnerability-scanner`/semgrep/trivy/depcheck/ort/grype、guard 的 eslint/trivy、inspect 的 ai-origin `git log`。
**显式例外**（别"顺手"改）：`guard/test-runner`（跑项目自己的测试套件，带 `env: CI=true`、数分钟级，无去重价值且重放会污染副作用）、`sentinel/*`（文件监听事件驱动，非一次运行）、`grype db update`（600s 后台维护任务，自带防重标志）。

直接 `execFile` 的后果是**逃出去重**：`gitleaks detect` 曾因 inspect 与 security 两套调用各起一次进程（实测一轮 3 次、argv 逐字节相同）。诊断开关：`ZH_TOOL_RUN_DEDUP=off` 关闭作用域去重；`pnpm verify:tool-dedup` 用 `scripts/lib/tool-spy.cjs` 数真实派发。

## ⛔ 暂下线功能（AI 禁止重新开启）
以下两项功能当前处于**产品性暂下线**状态，开关在 `packages/desktop/src/feature-flags.ts`（`FEATURE_AI_TOOL_ENABLED` / `FEATURE_EVOLVE_ENABLED`）。已从侧边栏隐藏入口并封死路由。

**任何 AI 助手都禁止**把这两个开关改回 `true`，或恢复侧边栏渲染 / 路由 / e2e 入口，除非**用户本人明确指示**重新开放某项功能（并同步恢复入口、文档与 e2e 用例）。原因：

| 功能 | 开关 | 暂下线原因 |
|------|------|-----------|
| AI 工具 | `FEATURE_AI_TOOL_ENABLED` | 功能未闭环：当前每次仍需用户手动把任务搬运到外部 AI 编程工具，侧边栏开关无法真正驱动完整 AI 流程 |
| 规则进化 | `FEATURE_EVOLVE_ENABLED` | 自动进化标准需要**足够规模的真实用户认可**才算数（启动门槛为千人级基础用户）；在几百/上千人认可并用过之前，单个人的判断不能成为“真实好用”的规则标准 |

涉及这两项的改动请求（“打开 AI 工具 / 恢复规则进化”等）一律先向用户确认，不得自行放行。

## 编码规范

- **注释语言**：所有代码注释统一使用中文（与已有代码风格一致）
- **错误信息**：面向用户的 i18n 文案走 `translate()`，开发者日志/注释用中文
- **PATH 补全**：`packages/shared/src/path-augment.ts` 的 `augmentProcessPath()`，由 Electron 主进程（`desktop/electron/env.ts` 薄壳传入 `__dirname`）与 CLI 入口（`cli/src/index.ts` 的 `main()` 顶部）在启动最早期调用，确保子进程继承完整 PATH（覆盖 nvm / Homebrew / ~/.local/bin / workspace .bin）
- **工具探测**：inspect adapters 使用 `packages/inspect/src/adapters/tool-bin.ts` 的 `resolveToolCommand()` 做 PATH + node_modules/.bin 二级解析
- **路径拼接安全（防路径穿越 CWE-22）**：任何拼接可能涉及外部/不可信片段（用户输入、HTTP 请求参数、文件名、仓库名、扫描目标等）的文件路径，必须使用 `@zh/shared` 的 `safeJoin(base, ...segments)` / `safeResolve(base, target)`，**禁止**直接用 `path.join` / `path.resolve` 拼接不可信片段。`safeJoin`/`safeResolve` 在目标逃出 `base` 时抛出 `PathTraversalError`。回归用例见各包 `src/__tests__/safe-path-regression.test.ts`；CI 巡检由 `packages/kernel/assets/semgrep/path-traversal.yml` 规则抽查（report-only）。注意：`safeJoin`/`safeResolve` 仅做词法校验（不解析 symlink）；当 `base` 可能包含不可信 symlink（如扫描不可信仓库、或路径来自 workspace/manifest 输入）时，改用 `safeJoinReal`（realpath 包含性校验）。
- **无新依赖**：不引入任何新的 npm 包，所有功能使用 Node.js 内置 API

## 重构健康度治理（Refactor Health Governance）

本仓库已引入 zhcheck 重构坏味道巡检 + **基线（baseline）+ ratchet 门禁**机制，用于防止坏味道回退并逐步收敛存量。

### 基线与门禁
- **基线文件**：`.refactor-baseline.json`（已提交）。记录当前存量坏味道：`{ "entries": { "<file>": { "<rule>": count, ... } }, "meta": {...} }`。
- **生成/更新基线**：`pnpm baseline:write`（等同 `node scripts/zhcheck.mjs --refactor --write-baseline`）
- **本地门禁（推荐）**：`pnpm check:staged`（`--refactor --inspect --staged --baseline --ci`）——仅对**新增**坏味道阻断提交。
- **全量校验**：`pnpm check:refactor:ci`（`--refactor --baseline --ci`）
- **语义**：`--baseline` 加载基线；`--ci` 时，若 `introduced > 0` 则 `exit 1`。存量坏味道（`resolved`）**不**阻断。`--staged` 模式会将基线收窄到被扫描文件，避免误报已修复文件。

### DoD（Definition of Done，坏味道预算）
修改代码前后必须满足：
- [ ] **类型检查全绿**：`node scripts/typecheck.mjs` 全部 21 包通过（或仅改动包 `tsc --noEmit` 通过且不影响上游类型）
- [ ] **相关测试全绿**：受影响包的 Vitest 全部通过（refactor 包改动需 `pnpm --filter @zh/refactor test` 全绿）
- [ ] **重构门禁通过**：`node scripts/zhcheck.mjs --refactor --baseline --ci`（全量）或 `pnpm check:staged`（暂存区）均需 `baseline diff — introduced: 0` 且退出码 0
- [ ] **最小改动**：优先抽取私有函数/常量消除重复，**不要**顺手大规模重命名、格式化无关代码
- [ ] **行为不变**：修复坏味道时不得改变公开 API、业务逻辑或 I/O 语义
- [ ] **验证证据**：必要时附上前后对比（行数、坏味道计数）并确保 lsp_diagnostics 在改动文件上清零

### 新文件约束
- **不得引入新增坏味道**：新增文件的坏味道计入 `introduced`，将直接触发门禁。原则上新增文件应**零**长方法（>80 行）、零超大文件（>400 行）、零文件内/跨文件高重复。
- **复用优先**：优先复用 `packages/shared` 已有工具（如 `escapeRegExp` 已集中于 `@zh/shared`），避免复制常量/正则。
- **e2e 豁免**：`packages/desktop/e2e/**` 已从 refactor 扫描范围排除（目录名匹配），但**产品代码**不得通过新增到 e2e 目录规避门禁。
- **谨慎豁免**：IPC 镜像等架构强制对（triage A 类）已由基线冻结。一般不新增引擎级 `ignoreGlobs`，仅在真实复用需求且有充足理由时再评估。

### 长期原则
- **分数非 KPI，净减少存量才是 KPI**：门禁只看「新增」（introduced），旨在**只降不升**，而非一味刷分。
- **小步迭代**：每次改动聚焦单个文件或极小范围，逐文件验证。大型页面重构需拆分为多次提交。
- **基线严肃对待**：`.refactor-baseline.json` 与治理改动一同提交。**不要**擅自重写基线来“通过”门禁；只有在**已验证修复**存量坏味道且改动范围可控时，才考虑配合 `baseline:write` 更新基线。
