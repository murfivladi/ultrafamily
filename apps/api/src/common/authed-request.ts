import type { Request } from 'express';
import type { UserProfile } from '@ufos/contracts';
import type { SessionRow } from '../db/rows';

export interface AuthenticatedUser extends UserProfile {
  passwordHash: string;
  failedLoginCount: number;
  lockedUntil: string | null;
}

export interface AuthedRequest extends Request {
  authUser?: AuthenticatedUser;
  authSession?: SessionRow;
}
