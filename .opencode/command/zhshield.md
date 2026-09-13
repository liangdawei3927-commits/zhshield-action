---
description: 读取智汇码盾诊断并修复代码问题
---

# 智汇码盾诊断修复

1. 读取项目根目录 `.zhshield/diagnostics/latest.json`（不存在则提示用户先运行体检）
2. 按 error → warning → info 优先级排序问题
3. 逐条理解问题、定位代码、生成并应用修复
4. 修复后运行 `zhshield issue resolve --fingerprint="<fingerprint>"` 标记已解决（可选）
