import { Module } from '@nestjs/common';
import { EvolveController } from './evolve.controller';
import { EvolveService } from './evolve.service';

@Module({
  controllers: [EvolveController],
  providers: [EvolveService],
  exports: [EvolveService],
})
export class EvolveModule {}
