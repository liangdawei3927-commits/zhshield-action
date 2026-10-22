# @zh/reporter

## 0.1.1

### Patch Changes

- 修复两处门禁链路缺陷：guardFindings 无 violations 分支此前透传原始 severity，越界值（如磁盘反序列化带入的 critical）令 severityRank 为 undefined、阈值比较恒 false，导致 CI 门禁静默放行——现统一走 toFindingSeverity 归一（合法三档恒等，越界 fail-closed 归 warning）；formatReportJson(undefined) 原生返回 undefined 违反 string 签名、令报告落盘 TypeError——现兜底为 null。
