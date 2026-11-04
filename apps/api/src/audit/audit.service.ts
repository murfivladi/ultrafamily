import { Injectable } from '@nestjs/common';
import type { AuditEvent } from '@ufos/contracts';
import { newId, sha256 } from '../config';
import { redact } from '../common/redact';
import { DatabaseService, type Queryable } from '../db/database.service';
import { toAuditEvent, type AuditRow } from '../db/rows';

export interface AuditInput {
  actorUserId?: string | null;
  actorEmail?: string | null;
  spaceId?: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class AuditService {
  constructor(private readonly db: DatabaseService) {}

  async record(input: AuditInput, existingClient?: Queryable): Promise<AuditEvent> {
    const run = async (tx: Queryable): Promise<AuditEvent> => {
      const control = await tx.queryOne<{ last_hash: string }>(
        'SELECT last_hash FROM audit_control WHERE id = 1 FOR UPDATE',
      );
      const previousHash = control?.last_hash ?? 'GENESIS';
      const id = newId('aud');
      const createdAt = new Date().toISOString();
      const metadata = redact(input.metadata ?? {});
      const canonicalPayload = JSON.stringify({
        id,
        createdAt,
        actorUserId: input.actorUserId ?? null,
        actorEmail: input.actorEmail ?? null,
        spaceId: input.spaceId ?? null,
        action: input.action,
        entity: input.entity,
        entityId: input.entityId ?? null,
        metadata,
      });
      const chainHash = sha256(`${previousHash}|${canonicalPayload}`);

      await tx.query(
        `INSERT INTO audit_events
          (id, created_at, actor_user_id, actor_email, space_id, action, entity,
           entity_id, metadata, canonical_payload, previous_hash, chain_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          id,
          createdAt,
          input.actorUserId ?? null,
          input.actorEmail ?? null,
          input.spaceId ?? null,
          input.action,
          input.entity,
          input.entityId ?? null,
          JSON.stringify(metadata),
          canonicalPayload,
          previousHash,
          chainHash,
        ],
      );
      await tx.query('UPDATE audit_control SET last_hash = $1 WHERE id = 1', [chainHash]);

      const row: AuditRow = {
        sequence: 0,
        id,
        created_at: createdAt,
        actor_user_id: input.actorUserId ?? null,
        actor_email: input.actorEmail ?? null,
        space_id: input.spaceId ?? null,
        action: input.action,
        entity: input.entity,
        entity_id: input.entityId ?? null,
        metadata,
        canonical_payload: canonicalPayload,
        previous_hash: previousHash,
        chain_hash: chainHash,
      };
      return toAuditEvent(row);
    };

    if (existingClient) return run(existingClient);
    return this.db.transaction(run);
  }

  async list(spaceId: string | null, limit = 50): Promise<AuditEvent[]> {
    const rows = spaceId
      ? await this.db.query<AuditRow>(
          'SELECT * FROM audit_events WHERE space_id = $1 ORDER BY sequence DESC LIMIT $2',
          [spaceId, Math.min(Math.max(limit, 1), 200)],
        )
      : await this.db.query<AuditRow>(
          'SELECT * FROM audit_events ORDER BY sequence DESC LIMIT $1',
          [Math.min(Math.max(limit, 1), 200)],
        );
    return rows.map(toAuditEvent);
  }

  async verifyChain(): Promise<{ valid: boolean; checked: number; brokenAt: string | null }> {
    const rows = await this.db.query<AuditRow>('SELECT * FROM audit_events ORDER BY sequence ASC');
    let previousHash = 'GENESIS';
    for (const row of rows) {
      const expected = sha256(`${previousHash}|${row.canonical_payload}`);
      if (expected !== row.chain_hash || row.previous_hash !== previousHash) {
        return { valid: false, checked: rows.length, brokenAt: row.id };
      }
      previousHash = row.chain_hash;
    }
    const control = await this.db.queryOne<{ last_hash: string }>(
      'SELECT last_hash FROM audit_control WHERE id = 1',
    );
    const valid = (control?.last_hash ?? 'GENESIS') === previousHash;
    return { valid, checked: rows.length, brokenAt: valid ? null : 'control' };
  }
}
