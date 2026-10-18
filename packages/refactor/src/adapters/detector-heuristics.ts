import * as ts from 'typescript';

/** 判断类是否为框架托管类（装饰器类）：TypeORM entity、class-validator DTO、Swagger DTO 等依赖类或成员上装饰器的运行时元数据，改写会破坏框架契约（列映射、校验、OpenAPI 文档），它们是合理的数据载体而非封装性/纯数据问题 */
export function isFrameworkManagedClass(node: ts.ClassDeclaration): boolean {
  const hasDecorators =
    (ts.canHaveDecorators(node) && (ts.getDecorators(node)?.length ?? 0) > 0) ||
    node.members.some((m) => ts.canHaveDecorators(m) && (ts.getDecorators(m)?.length ?? 0) > 0);
  return hasDecorators;
}

/** 判断文件是否为测试 fixtures：刻意构造的样例代码，用于驱动规则测试，不是生产反模式 */
export function isTestFixture(filePath: string): boolean {
  return filePath.includes('/__tests__/') || filePath.includes('/fixtures/');
}
