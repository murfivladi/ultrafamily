import { Module } from '@nestjs/common';
import { CalDavController } from './caldav.controller';
import { CalendarController } from './calendar.controller';
import { CalendarService } from './calendar.service';
import { IcsService } from './ics.service';

@Module({
  controllers: [CalendarController, CalDavController],
  providers: [CalendarService, IcsService],
  exports: [CalendarService, IcsService],
})
export class CalendarModule {}
