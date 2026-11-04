import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AuthedRequest, AuthenticatedUser } from './authed-request';

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser => {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    if (!request.authUser) throw new Error('CurrentUser used on an unauthenticated route');
    return request.authUser;
  },
);

export const CurrentRequest = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthedRequest => {
    return context.switchToHttp().getRequest<AuthedRequest>();
  },
);
