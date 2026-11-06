import { Module } from '@nestjs/common';
import { FilesModule } from '../files/files.module';
import { PhotosController } from './photos.controller';
import { PhotosService } from './photos.service';
import { PublicSharesController } from './public-shares.controller';

@Module({
  imports: [FilesModule],
  controllers: [PhotosController, PublicSharesController],
  providers: [PhotosService],
  exports: [PhotosService],
})
export class PhotosModule {}
