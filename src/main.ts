import { NestFactory } from '@nestjs/core';
import { AppConfigService } from './config/config.service.js';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  const config = app.get(AppConfigService);
  await app.listen(config.port);
}

bootstrap();
