import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PGlite } from '@electric-sql/pglite';
import { Pool, PoolClient, type QueryResultRow } from 'pg';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config';

export interface Queryable {
  query<Row extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<Row[]>;
  queryOne<Row extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<Row | null>;
}

// Stage A recorded a single semantic version before migrations became file-based.
// An existing Stage A database must not re-run 001_init.sql on a Stage B upgrade.
const LEGACY_MIGRATION_VERSION = '001_stage_a_foundation';
const LEGACY_VERSION_ALIASES: Record<string, string> = {
  [LEGACY_MIGRATION_VERSION]: '001_init',
};

function normalizeParams(params: unknown[]): unknown[] {
  return params.map((value) =>
    value !== null && typeof value === 'object' && !(value instanceof Date)
      ? JSON.stringify(value)
      : value,
  );
}

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy, Queryable {
  private pool?: Pool;
  private pglite?: PGlite;
  private readyPromise?: Promise<void>;
  private initialized = false;

  readonly driver = config.driver;

  onModuleInit(): Promise<void> {
    this.readyPromise = this.initialize().then(() => {
      this.initialized = true;
    });
    return this.readyPromise;
  }

  async onModuleDestroy(): Promise<void> {
    await this.pglite?.close();
    await this.pool?.end();
  }

  async ensureReady(): Promise<void> {
    if (this.initialized) return;
    if (!this.readyPromise) {
      this.readyPromise = this.initialize().then(() => {
        this.initialized = true;
      });
    }
    await this.readyPromise;
  }

  private async initialize(): Promise<void> {
    if (config.driver === 'postgres') {
      this.pool = new Pool({
        connectionString: config.databaseUrl,
        max: Number(process.env.DB_POOL_SIZE || 8),
        ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
      });
      const probe = await this.pool.connect();
      probe.release();
    } else {
      if (config.pgliteDataDir !== ':memory:' && !config.pgliteDataDir.startsWith('memory://')) {
        mkdirSync(config.pgliteDataDir, { recursive: true });
      }
      this.pglite =
        config.pgliteDataDir === ':memory:' || config.pgliteDataDir.startsWith('memory://')
          ? new PGlite()
          : new PGlite(config.pgliteDataDir);
      await this.pglite.waitReady;
    }
    await this.migrate();
  }

  private migrationDirectory(): string {
    const candidates = [
      path.join(__dirname, 'sql'),
      path.join(process.cwd(), 'src', 'db', 'sql'),
      path.join(process.cwd(), 'apps', 'api', 'src', 'db', 'sql'),
      path.resolve(__dirname, '../../../apps/api/src/db/sql'),
    ];
    const found = candidates.find((candidate) => existsSync(candidate));
    if (!found) throw new Error('Could not locate SQL migrations directory');
    return found;
  }

  private async migrate(): Promise<void> {
    await this.rawExec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    for (const [legacyVersion, currentVersion] of Object.entries(LEGACY_VERSION_ALIASES)) {
      const legacyApplied = await this.rawQueryOne<{ version: string }>(
        'SELECT version FROM schema_migrations WHERE version = $1',
        [legacyVersion],
      );
      if (legacyApplied) {
        await this.rawQuery(
          'INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING',
          [currentVersion],
        );
      }
    }
    const directory = this.migrationDirectory();
    const files = readdirSync(directory)
      .filter((file) => file.endsWith('.sql'))
      .sort();
    for (const file of files) {
      const version = path.basename(file, '.sql');
      const applied = await this.rawQueryOne<{ version: string }>(
        'SELECT version FROM schema_migrations WHERE version = $1',
        [version],
      );
      if (applied) continue;
      await this.rawExec(readFileSync(path.join(directory, file), 'utf8'));
      await this.rawQuery(
        'INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING',
        [version],
      );
    }
  }

  private async rawExec(sql: string): Promise<void> {
    if (this.pglite) {
      await this.pglite.exec(sql);
      return;
    }
    if (this.pool) {
      await this.pool.query(sql);
      return;
    }
    throw new Error('Database is not initialized');
  }

  private async rawQuery<Row extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: unknown[] = [],
  ): Promise<Row[]> {
    const normalized = normalizeParams(params);
    if (this.pglite) {
      const result = await this.pglite.query<Row>(sql, normalized as never[]);
      return result.rows;
    }
    if (this.pool) {
      const result = await this.pool.query<Row>(sql, normalized as never[]);
      return result.rows;
    }
    throw new Error('Database is not initialized');
  }

  private async rawQueryOne<Row extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: unknown[] = [],
  ): Promise<Row | null> {
    const rows = await this.rawQuery<Row>(sql, params);
    return rows[0] ?? null;
  }

  async exec(sql: string): Promise<void> {
    await this.ensureReady();
    await this.rawExec(sql);
  }

  async query<Row extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: unknown[] = [],
  ): Promise<Row[]> {
    await this.ensureReady();
    return this.rawQuery<Row>(sql, params);
  }

  async queryOne<Row extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: unknown[] = [],
  ): Promise<Row | null> {
    const rows = await this.query<Row>(sql, params);
    return rows[0] ?? null;
  }

  async transaction<T>(callback: (client: Queryable) => Promise<T>): Promise<T> {
    await this.ensureReady();
    if (this.pglite) {
      return this.pglite.transaction(async (tx) => {
        const adapter: Queryable = {
          query: async <Row extends QueryResultRow>(sql: string, params: unknown[] = []) => {
            const result = await tx.query<Row>(sql, normalizeParams(params) as never[]);
            return result.rows;
          },
          queryOne: async <Row extends QueryResultRow>(sql: string, params: unknown[] = []) => {
            const rows = await adapter.query<Row>(sql, params);
            return rows[0] ?? null;
          },
        };
        return callback(adapter);
      });
    }
    if (!this.pool) throw new Error('Database is not initialized');
    const client: PoolClient = await this.pool.connect();
    const adapter: Queryable = {
      query: async <Row extends QueryResultRow>(sql: string, params: unknown[] = []) => {
        const result = await client.query<Row>(sql, normalizeParams(params) as never[]);
        return result.rows;
      },
      queryOne: async <Row extends QueryResultRow>(sql: string, params: unknown[] = []) => {
        const rows = await adapter.query<Row>(sql, params);
        return rows[0] ?? null;
      },
    };
    try {
      await client.query('BEGIN');
      const result = await callback(adapter);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
