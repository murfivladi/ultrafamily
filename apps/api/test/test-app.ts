import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';
import { AppModule } from '../src/app.module';

export interface TestAccount {
  agent: ReturnType<typeof request.agent>;
  csrfToken: string;
  userId: string;
  spaces: Array<{ id: string; name: string; kind: string; role: string }>;
}

export async function createTestApp(): Promise<INestApplication> {
  const moduleRef: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    logger: false,
    bodyParser: false,
  });
  app.use(express.json({ limit: '1mb' }));
  app.use(
    express.text({
      type: [
        'text/calendar',
        'application/calendar+xml',
        'text/xml',
        'application/xml',
        'text/plain',
      ],
      limit: '1mb',
    }),
  );
  app.use(cookieParser());
  app.setGlobalPrefix('api');
  await app.init();
  return app;
}

export async function login(
  app: INestApplication,
  email: string,
  password = 'FamilyOS!2026',
): Promise<TestAccount> {
  const agent = request.agent(app.getHttpServer());
  const response = await agent.post('/api/auth/login').send({ email, password }).expect(200);
  const body = response.body as {
    csrfToken: string;
    user: { id: string };
    spaces: Array<{ id: string; name: string; kind: string; role: string }>;
  };
  return {
    agent,
    csrfToken: body.csrfToken,
    userId: body.user.id,
    spaces: body.spaces,
  };
}

export function householdSpaces(account: TestAccount) {
  return account.spaces.filter((space) => space.kind === 'household');
}
