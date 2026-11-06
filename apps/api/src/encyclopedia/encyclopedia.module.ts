import { Module } from '@nestjs/common';
import { EncyclopediaController, PublicFamilyController } from './encyclopedia.controller';
import { EncyclopediaService } from './encyclopedia.service';

@Module({
  controllers: [EncyclopediaController, PublicFamilyController],
  providers: [EncyclopediaService],
  exports: [EncyclopediaService],
})
export class EncyclopediaModule {}
