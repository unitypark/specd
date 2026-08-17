import { randomUUID } from 'node:crypto';
import {
  Catch,
  HttpException,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Request, Response } from 'express';

/**
 * The last thing between an unmapped error and a person reading "Internal
 * server error".
 *
 * Nest's default filter answers 500 with that string and nothing else. It is
 * the right *status* — an error nobody typed a message for is a bug, not a
 * user's mistake — but as an answer it is unusable in both directions: the
 * user cannot act on it, and whoever is asked about it cannot find the failure
 * in a log without knowing the minute it happened.
 *
 * Three failures in a row reached users that way (a fetch that never left, a
 * 404 at an API base, a login page where JSON was expected). Each was fixed at
 * its call site, which is right, and each was found by a person hitting it,
 * which is not. This filter does not fix any of them. It makes the next one
 * cost one message instead of a session: the response carries a short id, the
 * log carries the same id with the stack, and "500 with reference a3f2c1" is a
 * question somebody can answer.
 *
 * `HttpException`s pass through untouched — a 400 that says what is wrong is
 * already doing its job, and wrapping it would bury the message.
 */
@Catch()
export class UnhandledExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Unhandled');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      res.status(status).json(typeof body === 'string' ? { statusCode: status, message: body } : body);
      return;
    }

    // Short and pronounceable over a desk, because that is how it travels.
    const reference = randomUUID().slice(0, 8);
    const name = exception instanceof Error ? exception.constructor.name : typeof exception;

    this.logger.error(
      `${reference} · ${req.method} ${req.url} · ${name}: ${
        exception instanceof Error ? exception.message : String(exception)
      }`,
      exception instanceof Error ? exception.stack : undefined,
    );

    // The class of error is named in the response on purpose. `TypeError` and
    // `SyntaxError` are exactly the two that mean "an outbound call failed in
    // a way nobody wrapped", and saying so turns a bug report into a lead.
    res.status(500).json({
      statusCode: 500,
      error: 'Internal Server Error',
      reference,
      message:
        `Something failed inside specd and no handler had a better answer (${name}). ` +
        `Reference ${reference} — the full error is in the API log under that id.`,
    });
  }
}
