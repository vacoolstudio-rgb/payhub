import { registerAs } from '@nestjs/config';

export const appConfig = registerAs('app', () => ({
  port: Number(process.env.PORT),
}));

export const databaseConfig = registerAs('database', () => ({
  url: process.env.DATABASE_URL!,
}));
