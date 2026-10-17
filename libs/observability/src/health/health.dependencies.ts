/**
 * Which backing services this deployable actually talks to.
 *
 * The health controller is shared by four services that do not share a
 * dependency set — notifications has no database at all. Probing a
 * dependency a service does not have is not a harmless extra check: the
 * readiness probe fails forever, Kubernetes never adds the pod to the
 * service, and the rollout stalls on a process that is in fact perfectly
 * healthy. So each service declares its dependencies and the probes are
 * assembled from that declaration.
 */
export type HealthDependency = 'postgres' | 'redis' | 'outbox';

export const HEALTH_DEPENDENCIES = Symbol('HEALTH_DEPENDENCIES');

export const DEFAULT_HEALTH_DEPENDENCIES: readonly HealthDependency[] = [
  'postgres',
  'redis',
  'outbox',
];
