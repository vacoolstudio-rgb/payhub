export * from './envelope.js';
export * from './topics.js';
export * from './payment.contracts.js';
export * from './ledger.contracts.js';
export * from './identity.contracts.js';

import { IdentityEvents } from './identity.contracts.js';
import { LedgerCommands, LedgerEvents } from './ledger.contracts.js';
import { PaymentEvents } from './payment.contracts.js';

/** Registry used by consumers to look up a payload schema by event name. */
export const MessageRegistry = {
  ...PaymentEvents,
  ...LedgerCommands,
  ...LedgerEvents,
  ...IdentityEvents,
} as const;

export type MessageName = keyof typeof MessageRegistry;
