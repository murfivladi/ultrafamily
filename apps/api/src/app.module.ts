import { Module } from '@nestjs/common';
import { AccessModule } from './access/access.module';
import { AdminModule } from './admin/admin.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { CalendarModule } from './calendar/calendar.module';
import { CommonModule } from './common/common.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { DbModule } from './db/db.module';
import { HealthModule } from './health/health.module';
import { ModulesModule } from './modules/modules.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PublicModule } from './public/public.module';
import { PublishingModule } from './publishing/publishing.module';
import { RealtimeModule } from './realtime/realtime.module';
import { ShoppingModule } from './shopping/shopping.module';
import { SpacesModule } from './spaces/spaces.module';
import { TasksModule } from './tasks/tasks.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    // Global infrastructure.
    CommonModule,
    DbModule,
    AuditModule,
    AccessModule,
    RealtimeModule,
    NotificationsModule,

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

    // Stage B organizational core.
    CalendarModule,
    TasksModule,
    ShoppingModule,
    PublishingModule,
  ],
})
export class AppModule {}
