import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CacheService } from '@payhub/redis';

export interface WebhookTarget {
  readonly url: string;
  readonly secret: string;
}

/**
 * Minimal read of the merchant's webhook configuration.
 *
 * The worker deliberately does not import the merchant aggregate: it needs
 * two columns, not a domain object, and pulling the whole context in would
 * couple the worker's deploy to every merchant-domain change.
 *
 * Cached for a minute — a merchant changing their endpoint mid-flight is
 * rare, and the alternative is a query per webhook.
 */
@Injectable()
export class MerchantLookupService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly cache: CacheService,
  ) {}

  async webhookFor(merchantId: string, eventType: string): Promise<WebhookTarget | null> {
    const config = await this.cache.getOrSet<{
      url: string;
      secret: string;
      events: string[];
      active: boolean;
      status: string;
    }>(
      `merchant:webhook:${merchantId}`,
      async () => {
        const rows = (await this.dataSource.query(
          `SELECT webhook_url AS url, webhook_secret AS secret, webhook_events AS events,
                  webhook_active AS active, status
           FROM payhub.merchants WHERE id = $1`,
          [merchantId],
        )) as Array<{
          url: string | null;
          secret: string | null;
          events: string[];
          active: boolean;
          status: string;
        }>;

        const row = rows[0];
        if (!row?.url || !row.secret) {
          return null;
        }

        return {
          url: row.url,
          secret: row.secret,
          events: row.events,
          active: row.active,
          status: row.status,
        };
      },
      // Read once per webhook delivery; the worker fans out hard enough
      // that the L1 tier removes most of the Redis traffic.
      { ttlSec: 60, negativeTtlSec: 60, l1: true },
    );

    if (!config || !config.active || config.status !== 'active') {
      return null;
    }
    if (!config.events.includes('*') && !config.events.includes(eventType)) {
      return null;
    }

    return { url: config.url, secret: config.secret };
  }

  async invalidate(merchantId: string): Promise<void> {
    await this.cache.del(`merchant:webhook:${merchantId}`);
  }
}
