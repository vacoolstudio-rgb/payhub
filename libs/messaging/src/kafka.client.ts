import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  Kafka,
  type KafkaConfig as KafkaJsConfig,
  Partitioners,
  type SASLOptions,
  logLevel,
} from 'kafkajs';
import { type AppConfig, type KafkaConfig, appConfig, kafkaConfig } from '@payhub/config';

/**
 * Owns the single `Kafka` instance for the process.
 *
 * Why raw kafkajs instead of `@nestjs/microservices`' Kafka transport for the
 * core services: the Nest transport hides the consumer loop, which is exactly
 * the part that needs tuning here — manual retry topics, per-message
 * deduplication, partition pausing on backpressure and explicit DLQ routing.
 * The notifications service uses the Nest transport on purpose, so the two
 * styles can be compared side by side in one code base.
 */
@Injectable()
export class KafkaClientProvider {
  private readonly logger = new Logger(KafkaClientProvider.name);
  readonly kafka: Kafka;

  constructor(
    @Inject(kafkaConfig.KEY) private readonly config: KafkaConfig,
    @Inject(appConfig.KEY) private readonly app: AppConfig,
  ) {
    this.kafka = new Kafka(this.buildConfig());
  }

  private buildConfig(): KafkaJsConfig {
    // `satisfies` rather than an annotation: the inferred type keeps the
    // keys this object actually sets, so spreading it below cannot smuggle
    // an explicit `undefined` into an optional kafkajs option.
    const base = {
      clientId: `${this.config.clientId}-${this.app.serviceName}`,
      brokers: this.config.brokers,
      ssl: this.config.ssl,
      connectionTimeout: 10_000,
      requestTimeout: 30_000,
      retry: {
        initialRetryTime: 300,
        retries: 8,
        maxRetryTime: 30_000,
        // Full jitter: identical clients must not reconnect in lockstep after
        // a broker restart.
        factor: 0.2,
      },
      logLevel: this.app.isProduction ? logLevel.WARN : logLevel.INFO,
      logCreator: () => (entry) => {
        const message = `[kafkajs] ${entry.log.message}`;
        if (entry.level === logLevel.ERROR) this.logger.error(message);
        else if (entry.level === logLevel.WARN) this.logger.warn(message);
        else this.logger.debug(message);
      },
    } satisfies KafkaJsConfig;

    if (this.config.saslMechanism === 'none') {
      return base;
    }

    return { ...base, sasl: this.buildSasl(this.config.saslMechanism) };
  }

  /**
   * `SASLOptions` is a union discriminated on `mechanism`, so an object
   * whose `mechanism` is itself a union satisfies none of its members.
   * This used to be papered over with an `as`, which also silently
   * accepted a mechanism kafkajs does not support. Switching narrows it
   * properly and makes a new mechanism a compile error here.
   */
  private buildSasl(mechanism: Exclude<KafkaConfig['saslMechanism'], 'none'>): SASLOptions {
    const username = this.config.saslUsername ?? '';
    const password = this.config.saslPassword ?? '';

    switch (mechanism) {
      case 'plain':
        return { mechanism: 'plain', username, password };
      case 'scram-sha-256':
        return { mechanism: 'scram-sha-256', username, password };
      case 'scram-sha-512':
        return { mechanism: 'scram-sha-512', username, password };
    }
  }

  /**
   * Partitioner note: kafkajs' legacy default hashes differently from the
   * Java client, so a topic written by both would be partitioned
   * inconsistently. `DefaultPartitioner` (murmur2) matches the Java client.
   */
  get partitioner() {
    return Partitioners.DefaultPartitioner;
  }
}
