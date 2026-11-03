import { Module } from '@nestjs/common';
import { AccessModule } from './access/access.module';
import { AdminModule } from './admin/admin.module';
import { AuthModule } from './auth/auth.module';
import { CommonModule } from './common/common.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { DbModule } from './db/db.module';
import { HealthModule } from './health/health.module';
import { ModulesModule } from './modules/modules.module';
import { PublicModule } from './public/public.module';
import { SpacesModule } from './spaces/spaces.module';
import { UsersModule } from './users/users.module';
import { AuditModule } from './audit/audit.module';

@Module({
  imports: [
    // Global infrastructure.
    CommonModule,
    DbModule,
    AuditModule,
    AccessModule,

    // Public and account foundation.
    HealthModule,
    PublicModule,
    UsersModule,
    AuthModule,

    // Stage A internal modules.
    SpacesModule,
    ModulesModule,
    DashboardModule,
    AdminModule,
  ],
})
export class AppModule {}
