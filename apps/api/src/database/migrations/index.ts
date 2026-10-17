import { InitApiSchema1740000000001 } from './1740000000001-InitApiSchema.js';
import { WebhookDeliveries1740000000002 } from './1740000000002-WebhookDeliveries.js';
import { CounterpartyKeysetIndex1740000000003 } from './1740000000003-CounterpartyKeysetIndex.js';
import { CapturingRequiresTransfer1740000000006 } from './1740000000006-CapturingRequiresTransfer.js';
import { RefundTransferId1740000000007 } from './1740000000007-RefundTransferId.js';

/**
 * Migrations for the `payhub` schema.
 *
 * The API and the worker are two deployments of one bounded-context family
 * and share this schema, so they share one migration list. Only the API runs
 * them (`DATABASE_RUN_MIGRATIONS=true` there, false in the worker) —
 * two pods racing `runMigrations()` is a deadlock waiting to happen, and
 * TypeORM's advisory lock only protects within a single call.
 */
export const apiMigrations = [
  InitApiSchema1740000000001,
  WebhookDeliveries1740000000002,
  CounterpartyKeysetIndex1740000000003,
  CapturingRequiresTransfer1740000000006,
  RefundTransferId1740000000007,
];
