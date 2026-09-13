// 植入问题1：假 AWS AccessKey（gitleaks 应检出）
// 注意：勿用 AKIAIOSFODNN7EXAMPLE——AWS 文档示例值被 gitleaks allowlist 豁免，任何链路都检不出
export const AWS_ACCESS_KEY_ID = "AKIA1234ABCD5678EFGH";
export const dbPassword = "hunter2-super-secret";
