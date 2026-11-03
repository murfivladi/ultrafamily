import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import express, { type NextFunction, type Request, type Response } from 'express';
import { AppModule } from './app.module';
import { AppLogger } from './common/app-logger.service';
import { config } from './config';

function securityHeaders(request: Request, response: Response, next: NextFunction): void {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  response.setHeader('Cache-Control', 'no-store');
  next();
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: false,
    bodyParser: false,
  });
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '64kb' }));
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));
  app.use(cookieParser());
  app.use(securityHeaders);
  app.setGlobalPrefix('api');
  app.enableShutdownHooks();

  await app.listen(config.port, '0.0.0.0');
  const logger = app.get(AppLogger);
  logger.log('Ultra Family OS API started', {
    port: config.port,
    database: config.driver,
    version: config.version,
  });
}

void bootstrap().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: 'error',
      service: 'api',
      message: 'startup_failed',
      context: { error: error instanceof Error ? error.message : 'unknown' },
    }),
  );
  process.exitCode = 1;
});
