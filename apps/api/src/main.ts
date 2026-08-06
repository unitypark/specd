import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { Config } from './config.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: false });
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
  app.enableShutdownHooks();

  await app.listen(config.port);

  const logger = new Logger('specd');
  logger.log(`API listening on http://localhost:${config.port}/api`);
  logger.log(`Default model: ${config.defaultModel}`);
  if (!config.anthropicApiKey) {
    logger.warn(
      'ANTHROPIC_API_KEY is not set — agent runs will fail until a project supplies its own key.',
    );
  }
}

bootstrap().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
