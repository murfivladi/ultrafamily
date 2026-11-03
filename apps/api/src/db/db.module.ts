import { Global, Module } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { SeedService } from './seed.service';

@Global()
@Module({
  providers: [DatabaseService, SeedService],
  exports: [DatabaseService],
})
export class DbModule {}
