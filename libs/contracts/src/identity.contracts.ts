import { z } from 'zod';
import { defineEvent } from './envelope.js';
import { Topics } from './topics.js';

export const UserRegistered = defineEvent(
  'identity.user_registered.v1',
  Topics.IdentityEvents,
  z.object({
    userId: z.string().uuid(),
    email: z.string().email(),
    displayName: z.string().min(1),
    registeredAt: z.string().datetime({ offset: true }),
  }),
);

export const MerchantActivated = defineEvent(
  'identity.merchant_activated.v1',
  Topics.IdentityEvents,
  z.object({
    merchantId: z.string().uuid(),
    ownerUserId: z.string().uuid(),
    name: z.string().min(1),
    webhookUrl: z.string().url().nullable(),
    activatedAt: z.string().datetime({ offset: true }),
  }),
);

export const IdentityEvents = {
  [UserRegistered.name]: UserRegistered,
  [MerchantActivated.name]: MerchantActivated,
} as const;
