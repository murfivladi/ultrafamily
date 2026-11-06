import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureHttp } from '../src/http';

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
  configureHttp(app);
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
