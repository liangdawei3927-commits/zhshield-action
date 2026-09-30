/**
 * 请求体字段校验（request-body.ts）
 *
 * admin / tenancy 的三个控制器曾各写一份 requireString / optionalString /
 * parseStringArray。三者抛出的 BadRequestException 文案与边界判定都必须逐字一致，
 * 否则同一类请求在不同端点会得到不同报错，故收敛到本模块作为唯一来源。
 */
import { BadRequestException } from '@nestjs/common';

/** 必填字符串：非字符串或 trim 后为空即 400 */
export function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BadRequestException(`字段 ${field} 必须为非空字符串`);
  }
  return value;
}

/** 可选字符串：undefined / null 视为缺省返回 undefined，其余非字符串即 400 */
export function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new BadRequestException(`字段 ${field} 必须为字符串`);
  return value;
}

/** 字符串数组：缺省（undefined / null）返回空数组，非数组即 400，元素统一转字符串 */
export function parseStringArray(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new BadRequestException(`字段 ${field} 必须为字符串数组`);
  return value.map((v) => String(v));
}
