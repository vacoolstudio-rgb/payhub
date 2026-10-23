import { BadRequestException, HttpException, HttpStatus, Module } from '@nestjs/common';
import { ApolloDriver, type ApolloDriverConfig } from '@nestjs/apollo';
import { GraphQLModule as NestGraphQLModule } from '@nestjs/graphql';
import { GraphQLError, type GraphQLFormattedError } from 'graphql';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type AppConfig, appConfig } from '@payhub/config';
import { DomainError } from '@payhub/kernel';
import { MerchantModule } from '../modules/merchant/merchant.module.js';
import { PaymentModule } from '../modules/payment/payment.module.js';
import { WalletModule } from '../modules/wallet/wallet.module.js';
import { LoaderFactory } from './loaders/graphql.loaders.js';
import { GraphqlLoadersModule } from './loaders/loaders.module.js';
import { DashboardResolver } from './resolvers/dashboard.resolver.js';
import { queryCostPlugin } from './plugins/query-cost.plugin.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * GraphQL, scoped to the dashboard read model.
 *
 * Code-first: the schema is generated from the TypeScript models, so the
 * types the resolvers return and the types the schema advertises cannot
 * drift apart. Schema-first would mean maintaining both.
 *
 * Two things every production GraphQL endpoint needs and most tutorials
 * omit — a depth limit and introspection turned off in production — are
 * wired below. A public GraphQL endpoint without a depth limit is a
 * denial-of-service primitive handed to anyone with curl.
 */
/**
 * Errors GraphQL itself raises before a resolver runs: an unknown field,
 * a bad enum value, a syntax error. All of them describe the request, not
 * the server, and none of them carry anything internal.
 */
const CLIENT_FAULT_CODES = new Set([
  'QUERY_TOO_DEEP',
  'QUERY_TOO_EXPENSIVE',
  'GRAPHQL_PARSE_FAILED',
  'GRAPHQL_VALIDATION_FAILED',
  'BAD_USER_INPUT',
  'PERSISTED_QUERY_NOT_FOUND',
  'OPERATION_RESOLUTION_FAILURE',
]);

const codeOf = (formatted: GraphQLFormattedError): string =>
  typeof formatted.extensions?.['code'] === 'string'
    ? formatted.extensions['code']
    : 'BAD_USER_INPUT';

const isClientFault = (formatted: GraphQLFormattedError): boolean =>
  CLIENT_FAULT_CODES.has(codeOf(formatted));

/** Pulls class-validator's per-field messages out of the Nest exception. */
function validationMessages(exception: BadRequestException): string[] {
  const response = exception.getResponse();

  if (typeof response === 'object' && response !== null && 'message' in response) {
    const { message } = response as { message: unknown };
    if (Array.isArray(message)) {
      return message.map(String);
    }
    if (typeof message === 'string') {
      return [message];
    }
  }

  return [];
}

@Module({
  imports: [
    PaymentModule,
    WalletModule,
    MerchantModule,
    GraphqlLoadersModule,
    NestGraphQLModule.forRootAsync<ApolloDriverConfig>({
      driver: ApolloDriver,
      imports: [GraphqlLoadersModule],
      inject: [appConfig.KEY, LoaderFactory],
      useFactory: (config: AppConfig, loaders: LoaderFactory) => ({
        autoSchemaFile: join(here, '../../schema.gql'),
        sortSchema: true,
        path: '/graphql',
        playground: false,
        // The Apollo sandbox is a development convenience; in production it
        // is an invitation to explore the schema.
        introspection: !config.isProduction,
        csrfPrevention: true,
        // A fresh DataLoader set per request — see LoaderFactory for why
        // sharing them across requests is a correctness bug, not just a
        // caching nuance.
        context: ({ req, res }: { req: unknown; res: unknown }) => ({
          req,
          res,
          loaders: loaders.create(),
        }),
        // Depth alone left the door open: aliased root fields are all at
        // depth one, so fifty aggregates in one query passed cleanly. Cost
        // prices each field by what serving it actually involves.
        plugins: [queryCostPlugin({ maxDepth: 8, maxCost: 500 })],
        formatError: (formatted: GraphQLFormattedError, error: unknown): GraphQLFormattedError => {
          const original = error instanceof GraphQLError ? error.originalError : error;

          if (original instanceof DomainError) {
            return {
              message: original.message,
              extensions: {
                code: original.code,
                kind: original.kind,
                details: original.details,
              },
            };
          }

          // The ValidationPipe rejects a resolver's `@ArgsType` with a
          // BadRequestException whose useful part — the per-field messages
          // — lives in the response body, not in `message`.
          if (original instanceof BadRequestException) {
            return {
              message: 'Argument validation failed',
              extensions: { code: 'BAD_USER_INPUT', validation: validationMessages(original) },
            };
          }

          /**
           * Any 4xx is the caller's, and must keep its meaning.
           *
           * A rate limit arrived here as a plain `ThrottlerException` and
           * fell through to the catch-all, so exceeding a quota was
           * reported as `INTERNAL_SERVER_ERROR` — and in production would
           * have been flattened to "Internal server error", telling an
           * integrator to retry the one thing they should back off from.
           */
          if (original instanceof HttpException && original.getStatus() < 500) {
            return {
              message: original.message,
              extensions: {
                code:
                  original.getStatus() === HttpStatus.TOO_MANY_REQUESTS
                    ? 'RATE_LIMITED'
                    : 'BAD_USER_INPUT',
                status: original.getStatus(),
              },
            };
          }

          // A malformed query is the client's mistake. Redacting it with
          // everything else would tell an integrator their valid-looking
          // typo is a server fault, and would count their bug against our
          // error budget.
          if (isClientFault(formatted)) {
            return { message: formatted.message, extensions: { code: codeOf(formatted) } };
          }

          // Never leak a stack trace or an internal message to a client.
          return config.isProduction
            ? { message: 'Internal server error', extensions: { code: 'INTERNAL_ERROR' } }
            : formatted;
        },
      }),
    }),
  ],
  providers: [DashboardResolver],
})
export class GraphqlModule {}
