import { Injectable } from '@nestjs/common';
import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';

const KEY_LENGTH = 64;
const COST = 16384;
const BLOCK_SIZE = 8;
const PARALLELIZATION = 1;

function deriveKey(
  password: string,
  salt: Buffer,
  length: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, length, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey as Buffer);
    });
  });
}

@Injectable()
export class PasswordService {
  async hash(password: string): Promise<string> {
    const salt = randomBytes(16);
    const derived = await deriveKey(password, salt, KEY_LENGTH, {
      N: COST,
      r: BLOCK_SIZE,
      p: PARALLELIZATION,
    });
    return [
      'scrypt',
      String(COST),
      String(BLOCK_SIZE),
      String(PARALLELIZATION),
      salt.toString('base64url'),
      derived.toString('base64url'),
    ].join('$');
  }

  async verify(password: string, stored: string): Promise<boolean> {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, costText, blockText, parallelText, saltText, hashText] = parts;
    const cost = Number(costText);
    const block = Number(blockText);
    const parallel = Number(parallelText);
    if (!Number.isFinite(cost) || !Number.isFinite(block) || !Number.isFinite(parallel)) {
      return false;
    }
    try {
      const salt = Buffer.from(saltText ?? '', 'base64url');
      const expected = Buffer.from(hashText ?? '', 'base64url');
      const actual = await deriveKey(password, salt, expected.length, {
        N: cost,
        r: block,
        p: parallel,
        maxmem: 64 * 1024 * 1024,
      });
      return expected.length === actual.length && timingSafeEqual(expected, actual);
    } catch {
      return false;
    }
  }

  assertStrength(password: string): void {
    const longEnough = password.length >= 12 && password.length <= 128;
    const complex = /[a-zа-яё]/.test(password) && /[A-ZА-ЯЁ]/.test(password) && /\d/.test(password);
    if (!longEnough || !complex) {
      throw new Error('Password must be 12–128 characters and include upper/lowercase and a digit');
    }
  }
}
