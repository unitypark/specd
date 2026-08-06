import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { TokenClaims } from './auth.service.js';
import type { RequestWithUser } from './auth.guard.js';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): TokenClaims => {
    const req = ctx.switchToHttp().getRequest<RequestWithUser>();
    if (!req.user) throw new Error('CurrentUser used on an unauthenticated route');
    return req.user;
  },
);
