import { Controller, Get } from '@nestjs/common';
import { Public } from '../common/public.decorator';
import { config } from '../config';
import { DatabaseService } from '../db/database.service';

@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly db: DatabaseService) {}

  @Get()
  async check() {
    await this.db.query('SELECT 1 AS ok');
    return {
      status: 'ok',
      service: 'ultra-family-os-api',
      version: config.version,
      database: config.driver,
      demoMode: !config.isProduction,
      timestamp: new Date().toISOString(),
    };
  }
}
