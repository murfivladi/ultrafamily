import { Module } from '@nestjs/common';
import { AccessModule } from './access/access.module';
import { AdminModule } from './admin/admin.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { CalendarModule } from './calendar/calendar.module';
import { CallsModule } from './calls/calls.module';
import { CollaborationModule } from './collaboration/collaboration.module';
import { CommonModule } from './common/common.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { DecisionsModule } from './decisions/decisions.module';
import { DocumentsModule } from './documents/documents.module';
import { FeedModule } from './feed/feed.module';
import { DbModule } from './db/db.module';
import { HealthModule } from './health/health.module';
import { MessengerModule } from './messenger/messenger.module';
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

    // Stage C communication and collaboration.
    MessengerModule,
    FeedModule,
    DecisionsModule,
    DocumentsModule,
    CallsModule,
    CollaborationModule,
  ],
})
export class AppModule {}
