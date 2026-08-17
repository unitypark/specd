import 'reflect-metadata';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { UnhandledExceptionFilter } from './common/unhandled-exception.filter.js';
import { Config } from './config.js';
import { loadRootEnv } from './env.js';
import { EmbeddingService } from './knowledge/embeddings.js';


async function bootstrap(): Promise<void> {
  loadRootEnv();

  // rawBody: the GitHub webhook signature is an HMAC over the exact bytes
  // GitHub sent. Re-serialising the parsed JSON changes key order and
  // whitespace, and the signature would never verify again.
  const app = await NestFactory.create(AppModule, { bufferLogs: false, rawBody: true });
  const config = app.get(Config);

  app.setGlobalPrefix('api');
  app.enableCors({ origin: config.webOrigin, credentials: true });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  // An error nobody wrapped still answers 500, but with an id that is also in
  // the log next to its stack. "Internal server error" alone has cost three
  // round trips with a user to diagnose.
  app.useGlobalFilters(new UnhandledExceptionFilter());
  app.enableShutdownHooks();

  // Settle the embedder before serving. A model whose vectors do not fit the
  // pgvector column otherwise fails on insert, halfway through the first index
  // run, after the slow part is already done — and the error there names a
  // column, not the model anyone would need to change.
  await app.get(EmbeddingService).assertUsable();

  await app.listen(config.port);

  const logger = new Logger('specd');
  logger.log(`API listening on http://localhost:${config.port}/api`);
  logger.log(`Default model: ${config.defaultModel}`);
  if (!config.anthropicApiKey) {
    logger.warn(
      'ANTHROPIC_API_KEY is not set — agent runs will fail until a project supplies its own key.',
    );
  }
  if (config.githubAppConfigured) {
    logger.log(`GitHub App ${config.githubAppSlug} (id ${config.githubAppId})`);
    if (!config.githubWebhookSecret) {
      // Without a secret every delivery fails the signature check, so the App
      // looks connected while nothing it sends is ever acted on.
      logger.warn(
        'GITHUB_WEBHOOK_SECRET is not set — webhook deliveries will be rejected. ' +
          'Merges will not re-index until it is.',
      );
    }
  } else {
    logger.log('GitHub App not configured — local git mode only. See docs/github-app.md.');
  }
}

bootstrap().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
