import { Controller, Query, Sse } from '@nestjs/common';
import { Observable, from, switchMap } from 'rxjs';
import { AccessService } from '../access/access.service';
import type { AuthenticatedUser } from '../common/authed-request';
import { CurrentUser } from '../common/current-user.decorator';
import { RealtimeService } from './realtime.service';

interface SseMessage {
  data: string;
  id?: string;
  type?: string;
  retry?: number;
  comment?: string;
}

@Controller('realtime')
export class RealtimeController {
  constructor(
    private readonly access: AccessService,
    private readonly realtime: RealtimeService,
  ) {}

  @Sse('stream')
  stream(
    @CurrentUser() user: AuthenticatedUser,
    @Query('spaceId') spaceId: string,
    @Query('topics') topics = '',
  ): Observable<SseMessage> {
    const allowed = new Set(
      topics
        .split(',')
        .map((topic) => topic.trim())
        .filter(Boolean),
    );
    return from(this.access.assert(user.id, spaceId, 'dashboard', 'read')).pipe(
      switchMap(
        (context) =>
          new Observable<SseMessage>((subscriber) => {
            const heartbeat = setInterval(() => {
              subscriber.next({ data: '', comment: 'keepalive' });
            }, 25_000);
            const subscription = this.realtime.subscribe(context.spaceId).subscribe({
              next: (message) => {
                if (allowed.size > 0 && !allowed.has(message.topic)) return;
                subscriber.next({
                  id: message.id,
                  type: message.topic,
                  data: JSON.stringify(message),
                });
              },
            });
            return () => {
              clearInterval(heartbeat);
              subscription.unsubscribe();
            };
          }),
      ),
    );
  }
}
