import { Module } from '@nestjs/common';
import { FilesController } from './files.controller';
import { FilesService } from './files.service';
import { MediaQueueService } from './media-queue.service';
import { WebDavController } from './webdav.controller';

@Module({
  controllers: [FilesController, WebDavController],
  providers: [FilesService, MediaQueueService],
  exports: [FilesService, MediaQueueService],
})
export class FilesModule {}
