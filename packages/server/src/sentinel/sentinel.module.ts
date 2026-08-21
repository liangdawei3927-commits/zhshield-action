import { Module } from '@nestjs/common';
import { SentinelController } from './sentinel.controller';
import { SentinelService } from './sentinel.service';

@Module({
  controllers: [SentinelController],
  providers: [SentinelService],
  exports: [SentinelService],
})
export class SentinelModule {}
