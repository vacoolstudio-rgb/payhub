import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { loadEnv } from './env.js';
import { allConfigNamespaces } from './namespaces.js';

/**
 * Global configuration module.
 *
 * `validate` runs before any provider is instantiated, so an invalid
 * environment aborts `NestFactory.create()` rather than surfacing later as a
 * runtime `undefined`.
 */
@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      expandVariables: true,
      envFilePath: ['.env.local', '.env'],
      load: allConfigNamespaces,
      validate: (raw: Record<string, unknown>) => {
        // Throws EnvValidationError with every offending variable listed.
        loadEnv(raw as NodeJS.ProcessEnv);
        return raw;
      },
    }),
  ],
  exports: [NestConfigModule],
})
export class ConfigModule {}
