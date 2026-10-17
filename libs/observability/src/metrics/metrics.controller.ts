import { Controller, Get, Header, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '@payhub/shared';
import { MetricsService } from './metrics.service.js';

/**
 * Prometheus scrape endpoint.
 *
 * In a real cluster this listens on a separate port that is not exposed
 * through the ingress; here it stays on the main port but is excluded from
 * the public OpenAPI document.
 */
@ApiExcludeController()
@Controller({ path: 'metrics', version: VERSION_NEUTRAL })
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Public()
  @Get()
  @Header('cache-control', 'no-store')
  async scrape(): Promise<string> {
    return this.metrics.scrape();
  }
}
