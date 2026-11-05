import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DocumentsModule } from '../documents/documents.module';
import { CollaborationGateway } from './collaboration.gateway';

/**
 * Holds the process-local WebSocket gateway (chat/feed events, presence,
 * collaborative cursors, Yjs document updates and WebRTC signaling).
 * A single API process is assumed, matching the small-VPS deployment target.
 */
@Global()
@Module({
  imports: [AuthModule, DocumentsModule],
  providers: [CollaborationGateway],
  exports: [CollaborationGateway],
})
export class CollaborationModule {}
