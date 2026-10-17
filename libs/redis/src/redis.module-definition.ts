import { ConfigurableModuleBuilder } from '@nestjs/common';

export interface RedisModuleOptions {
  readonly url: string;
  readonly keyPrefix: string;
  readonly maxRetries: number;
  /** Separate connection for blocking commands / pub-sub subscribers. */
  readonly enableSubscriber?: boolean;
  readonly connectionName?: string;
}

/**
 * `ConfigurableModuleBuilder` generates the `forRoot` / `forRootAsync`
 * plumbing (options token, async providers, `extras`) that would otherwise be
 * ~80 lines of hand-written boilerplate per module.
 *
 * Compare with `PersistenceModule`, which is written by hand on purpose to
 * show what the builder actually produces.
 */
export const {
  ConfigurableModuleClass: ConfigurableRedisModuleClass,
  MODULE_OPTIONS_TOKEN: REDIS_MODULE_OPTIONS,
} = new ConfigurableModuleBuilder<RedisModuleOptions>({ moduleName: 'Redis' })
  .setClassMethodName('forRoot')
  .setExtras<{ isGlobal?: boolean }>({ isGlobal: true }, (definition, extras) => ({
    ...definition,
    // The builder fills the default above, so this is always a boolean —
    // `?? true` states that for the compiler instead of widening
    // `DynamicModule.global` to accept an undefined it never receives.
    global: extras.isGlobal ?? true,
  }))
  .build();
