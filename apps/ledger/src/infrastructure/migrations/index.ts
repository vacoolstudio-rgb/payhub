import { InitLedgerSchema1740000000000 } from './1740000000000-InitLedgerSchema.js';
import { DropRedundantWalletIndex1740000000004 } from './1740000000004-DropRedundantWalletIndex.js';
import { JournalEntriesAppendOnly1740000000005 } from './1740000000005-JournalEntriesAppendOnly.js';
import { ReversalForeignKeyIndexes1740000000009 } from './1740000000009-ReversalForeignKeyIndexes.js';
import { OutboxDispatchIndexPredicate1740000000011 } from './1740000000011-OutboxDispatchIndexPredicate.js';

/**
 * Migrations for the `ledger` schema, in one place.
 *
 * The api side has had this; the ledger kept its list inline in the
 * module, so the integration suites built their own schema by naming
 * `InitLedgerSchema` and nothing after it. That is a schema no
 * environment has ever run: every later migration — the append-only
 * trigger, the reversal indexes, the dispatch index — was invisible to
 * the tests meant to cover them, and a plan assertion written against
 * the real index failed because the container had the original.
 *
 * One exported list, imported by both the module and the tests, is what
 * stops the two drifting again.
 */
export const ledgerMigrations = [
  InitLedgerSchema1740000000000,
  DropRedundantWalletIndex1740000000004,
  JournalEntriesAppendOnly1740000000005,
  ReversalForeignKeyIndexes1740000000009,
  OutboxDispatchIndexPredicate1740000000011,
];
