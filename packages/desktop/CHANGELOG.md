# @zh/desktop

## 0.3.0

### Minor Changes

- 结清 0.2.0 之后累计 103 个提交（其中 feat/fix 70 个）因 changelog 声明断供导致的版本断层 —— 这些改动此前全部吞在同一个未发布版本号下，客户端 electron-updater 因版本未变化一直判定「已是最新」，实际一个都收不到。
  
  主要内容：
  
  - **巡检链路**：补全自动巡检触发（App 级每日兜底 + 首次添加项目自动首扫）；任务无进展看门狗，卡死任务不再永久阻塞队列；任务落定自动刷新分数；任务可见化（按钮/进度显示「自动巡检」，不再莫名显示「排队中」）
  - **评分与报告口径**：工具执行失败豁免扣分（对齐 CLI degraded 语义）；哨兵域 0 覆盖判 not-run（不再把「没监控」记成满分）；安全/技术债/refactor 三域扫描进度改真实接线，失败不再伪装成满分；报告中心总览与分类卡片改为实时同源快照
  - **分类页可操作性**：域主按钮可停止（取消链路贯通 + 哨兵监控可停）；详情入口统一派生；六个分类页详情入口收敛为共享 hook；分数环可点下钻；全球化筛选卡片机制兼容了 GUI 的取消/停止语义
  - **打包态正确性（P0）**：修复 asar 打包态下的资产路径（此前打包版所有外部工具直接静默失效）；显式 pin @typescript-eslint 三包（此前打包后主进程 MODULE_NOT_FOUND 卡死）
  - **依赖与漏洞**：Dual 固定版本改三元组比较；运行时版本检查改 semver 比对（消除 engines 范围误报）；依赖漏洞 26 → 2（8H/15M/3L → 1H/1M/0L）
  - **备份**：App 不在线时错过的定时调度启动即补跑；清理中断残留的 .zip.tmp；记录路径匹配改 realpath 归一（此前「打开备份目录」按钮全失效）；构建产物目录纳入强制排除
  - **代码治理能力**：重构棘轮基线全链路接通（存量进基线、报告只报增量）；duplicated-code 双向去重且跨包落点按真实依赖方向判定；mixed-responsibilities 默认下线
  - **i18n**：五语言补齐停止/排队/代码异味/工具失败文案
  
  注：本项为一次性结清，此后版本号由 CI 漂移门禁（`.github/workflows/ci.yml` 的 version-drift job）强制在发布前递进。

## 0.2.0

### Minor Changes

- MCP Server 冷项目首次引导与 toolError 通道分离：getIssues/getDiagnostics 对从未体检过的项目自动执行首轮巡检并回退读取最新报告（latest.json → zhshield.json），第三方工具冷启动即可拿到有效结果；外部工具执行报错（*.external.*）归入独立 toolErrors 通道返回，findings 不再混入工具报错噪音。本项为 0.2.0 发布主特性。

### Patch Changes

- Updated dependencies
  - @zh/reporter@0.1.1
