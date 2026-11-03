import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AppLogger } from './app-logger.service';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: AppLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const isHttp = exception instanceof HttpException;
    const status = isHttp ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    let message = 'Internal server error';
    let code = 'internal_error';
    if (isHttp) {
      const payload = exception.getResponse();
      if (typeof payload === 'string') {
        message = payload;
      } else if (payload && typeof payload === 'object') {
        const record = payload as Record<string, unknown>;
        if (typeof record.message === 'string') message = record.message;
        else if (Array.isArray(record.message)) message = record.message.join('; ');
        if (typeof record.error === 'string') code = record.error;
        if (typeof record.code === 'string') code = record.code;
      }
    }

    if (status >= 500) {
      this.logger.error('Unhandled API error', {
        method: request.method,
        path: request.path,
        status,
        error: exception instanceof Error ? exception.message : 'unknown',
      });
    }

    response.status(status).json({
      statusCode: status,
      code,
      message: status >= 500 ? 'Internal server error' : message,
      requestId: request.headers['x-request-id'] || null,
    });
  }
}
