# zhshield-cli

## 0.1.1

### Patch Changes

- 修复两处 CLI 边界崩溃：--report 指定的父目录不存在时自动递归创建，不再裸抛 ENOENT；bundled SOP 目录解析对"路径是文件"的情况（existsSync 不区分目录）返回 undefined 回退默认路径，不再抛 ENOTDIR 启动崩溃。
