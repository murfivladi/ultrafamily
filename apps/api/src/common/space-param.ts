import { BadRequestException } from '@nestjs/common';

export function spaceFrom(body: unknown): string {
  const spaceId = (body as { spaceId?: string } | null)?.spaceId;
  if (!spaceId || typeof spaceId !== 'string') throw new BadRequestException('spaceId_required');
  return spaceId;
}

export function querySpace(spaceId?: string): string {
  if (!spaceId) throw new BadRequestException('spaceId_required');
  return spaceId;
}
