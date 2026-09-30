/** 版本查询入参：客户端当前持有的 SOP 版本 */
export interface VersionQueryDto {
  currentVersion: string;
}

/** 差异查询入参：请求 from → to 两个版本之间的规则差异 */
export interface DiffQueryDto {
  from: string;
  to: string;
}

/** 应急拉取入参：缺省拉取全部分类，指定 category 时仅拉该分类 */
export interface EmergencyPullDto {
  category?: string;
}
