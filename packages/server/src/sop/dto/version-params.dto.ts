import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class VersionQueryDto {
  @ApiProperty({ description: '当前客户端版本号', example: '1.2026.07.31.001' })
  currentVersion!: string;
}

export class DiffQueryDto {
  @ApiProperty({ description: '起始版本号', example: '1.2026.07.01.001' })
  from!: string;

  @ApiProperty({ description: '目标版本号', example: '1.2026.07.31.001' })
  to!: string;
}

export class EmergencyPullDto {
  @ApiPropertyOptional({ description: '规则分类筛选', example: 'security' })
  category?: string;
}
