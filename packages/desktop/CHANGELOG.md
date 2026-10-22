# @zh/desktop

## 0.2.0

### Minor Changes

- MCP Server 冷项目首次引导与 toolError 通道分离：getIssues/getDiagnostics 对从未体检过的项目自动执行首轮巡检并回退读取最新报告（latest.json → zhshield.json），第三方工具冷启动即可拿到有效结果；外部工具执行报错（*.external.*）归入独立 toolErrors 通道返回，findings 不再混入工具报错噪音。本项为 0.2.0 发布主特性。

### Patch Changes

- Updated dependencies
  - @zh/reporter@0.1.1
