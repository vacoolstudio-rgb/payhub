import { Controller, Get, Inject, VERSION_NEUTRAL } from '@nestjs/common';
import {
  DiskHealthIndicator,
  HealthCheck,
  HealthCheckService,
  type HealthIndicatorFunction,
  MemoryHealthIndicator,
  TypeOrmHealthIndicator,
} from '@nestjs/terminus';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '@payhub/shared';
import { RedisHealthIndicator } from './redis.health.js';
import { OutboxHealthIndicator } from './outbox.health.js';
import { HEALTH_DEPENDENCIES, type HealthDependency } from './health.dependencies.js';

type Probe = HealthIndicatorFunction;

/**
 * Three distinct probes, because Kubernetes asks three different questions.
 *
 * • `/health/live`   — "is the process wedged?" Must not touch dependencies:
 *   restarting a pod because Redis blinked turns a dependency outage into an
 *   outage of your own service.
 * • `/health/ready`  — "can it serve traffic?" Checks everything a request
 *   needs, so a pod with a broken database is pulled out of the load balancer
 *   instead of serving 500s.
 * • `/health/startup`— slow first-boot work (migrations, cache warm-up) gets
 *   its own budget so the liveness probe does not kill a cold start.
 *
 * Only `live` is unconditional. The others are assembled from the
 * dependencies this service declared, because the same controller serves
 * four deployables with four different dependency sets.
 */
@ApiTags('health')
// Version-neutral: an orchestrator's probe URL must not change when the
// business API moves from v1 to v2.
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: TypeOrmHealthIndicator,
    private readonly redis: RedisHealthIndicator,
    private readonly outbox: OutboxHealthIndicator,
    private readonly memory: MemoryHealthIndicator,
    private readonly disk: DiskHealthIndicator,
    @Inject(HEALTH_DEPENDENCIES)
    private readonly dependencies: ReadonlySet<HealthDependency>,
  ) {}

  /** Keeps a probe only when this service actually has that dependency. */
  private only(probes: ReadonlyArray<readonly [HealthDependency, Probe]>): Probe[] {
    return probes.filter(([dependency]) => this.dependencies.has(dependency)).map(([, probe]) => probe);
  }

  @Public()
  @Get('live')
  @HealthCheck()
  @ApiOperation({ summary: 'Liveness probe — process-local checks only' })
  live() {
    return this.health.check([
      () => this.memory.checkHeap('memory_heap', 1_024 * 1_024 * 1_024),
      () => this.memory.checkRSS('memory_rss', 1_536 * 1_024 * 1_024),
    ]);
  }

  @Public()
  @Get('ready')
  @HealthCheck()
  @ApiOperation({ summary: 'Readiness probe — every dependency a request needs' })
  ready() {
    return this.health.check(
      this.only([
        ['postgres', () => this.db.pingCheck('postgres', { timeout: 1_500 })],
        ['redis', () => this.redis.isHealthy('redis')],
      ]),
    );
  }

  @Public()
  @Get('startup')
  @HealthCheck()
  @ApiOperation({ summary: 'Startup probe — slow boot work' })
  startup() {
    return this.health.check([
      ...this.only([['postgres', () => this.db.pingCheck('postgres', { timeout: 10_000 })]]),
      () => this.disk.checkStorage('disk', { path: '/', thresholdPercent: 0.95 }),
    ]);
  }

  @Public()
  @Get('deep')
  @HealthCheck()
  @ApiOperation({ summary: 'Operational view used by dashboards, not by the orchestrator' })
  deep() {
    return this.health.check(
      this.only([
        ['postgres', () => this.db.pingCheck('postgres', { timeout: 3_000 })],
        ['redis', () => this.redis.isHealthy('redis')],
        ['outbox', () => this.outbox.check('outbox')],
      ]),
    );
  }
}
