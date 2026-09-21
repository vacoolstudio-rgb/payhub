import { z } from 'zod';

export const envSchema = z.object({
  DATABASE_URL: z.string().min(1),

  PORT: z.coerce.number().int().min(1).max(65535),
});

export type Env = z.infer<typeof envSchema>;
