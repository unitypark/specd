import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AuthService, type TokenClaims } from './auth.service.js';

export const PUBLIC_KEY = 'specd:public';
export const Public = () => SetMetadata(PUBLIC_KEY, true);

/** Routes the CLI may call. Everything else is web-token only (D13). */
export const CLI_ALLOWED_KEY = 'specd:cliAllowed';
export const CliAllowed = () => SetMetadata(CLI_ALLOWED_KEY, true);

export interface RequestWithUser extends Request {
  user?: TokenClaims;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<RequestWithUser>();
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token) throw new UnauthorizedException('Missing bearer token');

    const claims = await this.auth.verifyToken(token);

    if (claims.aud === 'cli') {
      const cliAllowed = this.reflector.getAllAndOverride<boolean>(CLI_ALLOWED_KEY, [
        context.getHandler(),
        context.getClass(),
      ]);
      if (!cliAllowed) {
        // The CLI fetches, registers and reports. It never authors, reviews or
        // approves — the gate and the review surface stay in the app (D13).
        throw new UnauthorizedException(
          'This action is not available to CLI tokens. Use the web app.',
        );
      }
    }

    req.user = claims;
    return true;
  }
}
