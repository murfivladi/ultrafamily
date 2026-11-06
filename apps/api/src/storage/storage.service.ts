import { Injectable, OnModuleInit } from '@nestjs/common';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { config } from '../config';

export interface StorageDiskStatus {
  driver: 'local' | 's3';
  freeBytes: number | null;
  totalBytes: number | null;
  lowSpace: boolean;
  note: string;
}

/**
 * Storage abstraction for binary content. Database rows only keep opaque keys,
 * so a future S3-compatible adapter can replace the local disk without any
 * schema change. Local disk on the VPS is NOT a backup (see BACKUP-RESTORE.md).
 */
export interface StorageAdapter {
  readonly driver: 'local' | 's3';
  put(key: string, data: Buffer): Promise<void>;
  append(key: string, data: Buffer): Promise<void>;
  move(from: string, to: string): Promise<void>;
  copy(from: string, to: string): Promise<void>;
  size(key: string): Promise<number | null>;
  read(key: string, range?: { start: number; end: number }): Readable;
  readBuffer(key: string, maxBytes?: number): Promise<Buffer>;
  truncate(key: string, length: number): Promise<void>;
  delete(key: string): Promise<void>;
  /** Absolute local path for trusted local engines (OCR/antivirus); null for remote stores. */
  localPath(key: string): string | null;
  diskStatus(): Promise<StorageDiskStatus>;
}

const KEY_PATTERN = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_.-]+)*$/;

export function assertStorageKey(key: string): void {
  if (!KEY_PATTERN.test(key) || key.includes('..')) {
    throw new Error('invalid_storage_key');
  }
}

class LocalDiskStorage implements StorageAdapter {
  readonly driver = 'local' as const;

  constructor(private readonly root: string) {}

  private resolve(key: string): string {
    assertStorageKey(key);
    const target = path.resolve(this.root, key);
    if (!target.startsWith(path.resolve(this.root) + path.sep)) {
      throw new Error('invalid_storage_key');
    }
    return target;
  }

  async init(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
  }

  async put(key: string, data: Buffer): Promise<void> {
    const target = this.resolve(key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(temp, data);
    await fs.rename(temp, target);
  }

  async append(key: string, data: Buffer): Promise<void> {
    const target = this.resolve(key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.appendFile(target, data);
  }

  async move(from: string, to: string): Promise<void> {
    const source = this.resolve(from);
    const target = this.resolve(to);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.rename(source, target);
  }

  async copy(from: string, to: string): Promise<void> {
    const target = this.resolve(to);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(this.resolve(from), target);
  }

  async size(key: string): Promise<number | null> {
    try {
      const stat = await fs.stat(this.resolve(key));
      return stat.size;
    } catch {
      return null;
    }
  }

  read(key: string, range?: { start: number; end: number }): Readable {
    return createReadStream(this.resolve(key), range);
  }

  async readBuffer(key: string, maxBytes?: number): Promise<Buffer> {
    const target = this.resolve(key);
    if (maxBytes === undefined) return fs.readFile(target);
    const handle = await fs.open(target, 'r');
    try {
      const buffer = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  async truncate(key: string, length: number): Promise<void> {
    await fs.truncate(this.resolve(key), length);
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.resolve(key), { force: true });
  }

  localPath(key: string): string | null {
    return this.resolve(key);
  }

  async diskStatus(): Promise<StorageDiskStatus> {
    try {
      const stats = await fs.statfs(this.root);
      const freeBytes = Number(stats.bavail) * Number(stats.bsize);
      const totalBytes = Number(stats.blocks) * Number(stats.bsize);
      const lowSpace = freeBytes < config.storage.minFreeBytes;
      return {
        driver: 'local',
        freeBytes,
        totalBytes,
        lowSpace,
        note: lowSpace ? 'storage_low_disk_space' : 'local_disk_is_not_a_backup',
      };
    } catch {
      return {
        driver: 'local',
        freeBytes: null,
        totalBytes: null,
        lowSpace: false,
        note: 'storage_statfs_unavailable',
      };
    }
  }
}

@Injectable()
export class StorageService implements OnModuleInit {
  readonly adapter: StorageAdapter;

  constructor() {
    if (config.storage.driver === 's3') {
      // The interface is ready; the S3-compatible implementation is a planned
      // follow-up. Refuse to start instead of silently writing elsewhere.
      throw new Error('STORAGE_DRIVER=s3 is not implemented yet; use STORAGE_DRIVER=local');
    }
    this.adapter = new LocalDiskStorage(config.storage.dir);
  }

  async onModuleInit(): Promise<void> {
    await (this.adapter as LocalDiskStorage).init();
  }
}
