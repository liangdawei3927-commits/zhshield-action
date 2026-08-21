import { Module } from '@nestjs/common';
import { RefactorController } from './refactor.controller';
import { RefactorService } from './refactor.service';

@Module({
  controllers: [RefactorController],
  providers: [RefactorService],
  exports: [RefactorService],
})
export class RefactorModule {}
