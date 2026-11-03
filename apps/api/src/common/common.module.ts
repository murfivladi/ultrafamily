import { Global, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { AppLogger } from './app-logger.service';
import { PasswordService } from './password.service';

@Global()
@Module({
  providers: [
    AppLogger,
    PasswordService,
    {
      provide: APP_FILTER,
      inject: [AppLogger],
      useFactory: (logger: AppLogger) => new AllExceptionsFilter(logger),
    },
  ],
  exports: [AppLogger, PasswordService],
})
export class CommonModule {}
