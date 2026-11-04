import { Injectable } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';
import { newId } from '../config';
import { redact } from '../common/redact';
import { DatabaseService } from '../db/database.service';

export interface RealtimeMessage {
  id: string;
  spaceId: string;
  topic: string;
  actorUserId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

@Injectable()
export class RealtimeService {
  private readonly channels = new Map<string, Subject<RealtimeMessage>>();

  constructor(private readonly db: DatabaseService) {}

  subscribe(spaceId: string): Observable<RealtimeMessage> {
    let channel = this.channels.get(spaceId);
    if (!channel) {
      channel = new Subject<RealtimeMessage>();
      this.channels.set(spaceId, channel);
    }
    return channel.asObservable();
  }

  publish(
    spaceId: string,
    topic: string,
    actorUserId: string | null,
    payload: Record<string, unknown> = {},
  ): RealtimeMessage {
    const message: RealtimeMessage = {
      id: newId('rt'),
      spaceId,
      topic,
      actorUserId,
      payload: redact(payload),
      createdAt: new Date().toISOString(),
    };
    this.channels.get(spaceId)?.next(message);
    void this.db
      .query(
        'INSERT INTO realtime_events (id, space_id, topic, actor_user_id) VALUES ($1,$2,$3,$4)',
        [message.id, spaceId, topic, actorUserId],
      )
      .catch(() => undefined);
    return message;
  }
}
